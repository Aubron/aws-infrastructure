import SNS = require('@aws-cdk/aws-sns');
import EC2 = require('@aws-cdk/aws-ec2');
import RDS = require('@aws-cdk/aws-rds');
import ECS = require('@aws-cdk/aws-ecs');
import ELB2 = require('@aws-cdk/aws-elasticloadbalancingv2');
import Logs = require('@aws-cdk/aws-logs');
import IAM = require('@aws-cdk/aws-iam');
import cdk = require('@aws-cdk/core');
import CloudWatch = require('@aws-cdk/aws-cloudwatch');
import { Ec2Service } from '@aws-cdk/aws-ecs';
import { Vpc } from '@aws-cdk/aws-ec2';
import { join } from 'path';

const DATABASE_NAME = "prisma-db"
const PRISMA_VERSION = "1.34.0"
const FARGATE_CPU = "1024"
const FARGATE_MEMORY  = "2048"
const JVM_OPTS = "-Xmx1350m"


interface PrismaServiceStackProps extends cdk.StackProps {
    cluster: RDS.CfnDBCluster;
}

export class PrismaServiceStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props: PrismaServiceStackProps) {
    super(scope, id, props);

    const VPC = new EC2.CfnVPC(this, 'VPC', {
        cidrBlock: "10.0.0.0/16",
        enableDnsHostnames: true,
        enableDnsSupport: true,
    })
    // create subnets to launch on
    const publicSubnet1 = new EC2.CfnSubnet(this, 'PublicSubnet1', {
        vpcId: VPC.ref,
        availabilityZone: "us-east-2b",
        cidrBlock: "10.0.0.0/24",
        mapPublicIpOnLaunch: true,
        tags: [
            new cdk.Tag("Name",`${DATABASE_NAME} Public Subnet (AZ1)`)
        ]
    })

    const publicSubnet2 = new EC2.CfnSubnet(this, 'PublicSubnet2', {
        vpcId: VPC.ref,
        availabilityZone: "us-east-2a",
        cidrBlock: "10.0.1.0/24",
        mapPublicIpOnLaunch: true,
        tags: [
            new cdk.Tag("Name",`${DATABASE_NAME} Public Subnet (AZ2)`)
        ]
    })

    const internetGateway = new EC2.CfnInternetGateway(this, 'InternetGateway')

    const internetGatewayAttachment = new EC2.CfnVPCGatewayAttachment(this, 'InternetGatewayAttachment', {
        internetGatewayId: internetGateway.ref,
        vpcId: VPC.ref
    })

    const publicRouteTable = new EC2.CfnRouteTable(this, 'PublicRouteTable', {
        vpcId: VPC.ref
    })

    const publicRoute = new EC2.CfnRoute(this, 'PublicRoute', {
        routeTableId: publicRouteTable.ref,
        destinationCidrBlock: "0.0.0.0/0",
        gatewayId: internetGateway.ref,
    })

    publicRoute.addDependsOn(internetGatewayAttachment);

    const publicSubnet1RouteTableAssociation = new EC2.CfnSubnetRouteTableAssociation(this, 'PublicSubnet1RouteTableAssociation', {
        routeTableId: publicRouteTable.ref,
        subnetId: publicSubnet1.ref
    })
    const publicSubnet2RouteTableAssociation = new EC2.CfnSubnetRouteTableAssociation(this, 'PublicSubnet2RouteTableAssociation', {
        routeTableId: publicRouteTable.ref,
        subnetId: publicSubnet2.ref
    })

    const ecsCluster = new ECS.CfnCluster(this, 'ECSCluster');

    const fargateContainerSecurityGroup = new EC2.CfnSecurityGroup(this, 'FargateContainerSecurityGroup', {
        groupDescription: "Access to the Fargate containers",
        vpcId: VPC.ref
    })

    const EcsSecurityGroupIngressFromPublicALB = new EC2.CfnSecurityGroupIngress(this, 'EcsSecurityGroupFromPublicALB', {
        description: "Ingress from the public ALB",
        groupId: fargateContainerSecurityGroup.ref,
        ipProtocol: "-1",
        sourceSecurityGroupId: fargateContainerSecurityGroup.ref
    })

    const ecsSecurityGroupFromSelf = new EC2.CfnSecurityGroupIngress(this, 'EcsSecurityGroupIngressFromSelf', {
        description: "Ingress from other containers in the same security group",
        groupId: fargateContainerSecurityGroup.ref,
        ipProtocol: "-1",
        sourceSecurityGroupId: fargateContainerSecurityGroup.ref
    })

    const publicLoadBalancerSG = new EC2.CfnSecurityGroup(this, 'PublicLoadBalancerSG', {
        groupDescription: "Access to the public facing load balancer",
        vpcId: VPC.ref,
        securityGroupIngress: [{
        cidrIp: "0.0.0.0/0",
        ipProtocol: "-1"
        }]
    })

    const publicLoadBalancer = new ELB2.CfnLoadBalancer(this, 'PublicLoadBalancer', {
      scheme: "internet-facing",
      loadBalancerAttributes: [{
        key: "idle_timeout.timeout_seconds",
        value: "30"
      }],
      subnets: [
        publicSubnet1.ref,
        publicSubnet2.ref
      ],
      securityGroups: [
        publicLoadBalancerSG.ref
      ]
    })

    const prismaTargetGroup = new ELB2.CfnTargetGroup(this, 'PrismsTargetGroup', {
      healthCheckIntervalSeconds: 6,
      healthCheckPath: "/status",
      healthCheckProtocol: "HTTP",
      healthCheckTimeoutSeconds: 5,
      healthyThresholdCount: 2,
      name: [this.stackName,'prisma'].join('-'),
      port: 80,
      protocol: "HTTP",
      unhealthyThresholdCount: 2,
      vpcId: VPC.ref,
      targetType: "ip"
    })

    const publicLoadBalancerListener = new ELB2.CfnListener(this, 'PublicLoadBalancerListener', {
      defaultActions: [{
        targetGroupArn: prismaTargetGroup.ref,
        type: "forward"
      }],
      loadBalancerArn: publicLoadBalancer.ref,
      port: 80,
      protocol: "HTTP"
    })
    publicLoadBalancerListener.addDependsOn(publicLoadBalancer);

    const prismaLogs = new Logs.CfnLogGroup(this, 'PrismaLogs', {
      logGroupName: this.stackName,
      retentionInDays: 7
    })

    

    //Execution roles needed for the ECS
    const ecsRole = new IAM.CfnRole(this, 'ECSRole', {
      assumeRolePolicyDocument: new IAM.PolicyDocument({
        statements: [
            new IAM.PolicyStatement({
                effect: IAM.Effect.ALLOW,
                principals: [
                    new IAM.ServicePrincipal('ecs.amazonaws.com')
                ],
                actions: [
                    'sts:AssumeRole'
                ]
            })
        ]
    }),
      path: "/",
      policies: [
        {
          policyName: "ecs-service",
          policyDocument: new IAM.PolicyDocument({
            statements: [
                new IAM.PolicyStatement({
                    effect: IAM.Effect.ALLOW,
                    actions: [
                    //awsvpc networking - allow ecs to attach network interfaces to instances
                    'ec2:AttachNetworkInterface',
                    'ec2:CreateNetworkInterface',
                    'ec2:CreateNetworkInterfacePermission',
                    'ec2:DeleteNetworkInterface',
                    'ec2:DeleteNetworkInterfacePermission',
                    'ec2:Describe*',
                    'ec2:DetachNetworkInterface',
                    //allow ecs to update load balancers
                    'elasticloadbalancing:DeregisterInstancesFromLoadBalancer',
                    'elasticloadbalancing:DeregisterTargets',
                    'elasticloadbalancing:Describe*',
                    'elasticloadbalancing:RegisterInstancesWithLoadBalancer',
                    'elasticloadbalancing:RegisterTargets',
                    ],
                    resources: ["*"]
                })
            ]
            
          })
        }
      ]
    })
    
    const ecsTaskExecutionRole = new IAM.CfnRole(this, 'ECSTaskExecutionRole', {
    assumeRolePolicyDocument: new IAM.PolicyDocument({
        statements: [
            new IAM.PolicyStatement({
                effect: IAM.Effect.ALLOW,
                principals: [
                    new IAM.ServicePrincipal('ecs-tasks.amazonaws.com')
                ],
                actions: [
                    'sts:AssumeRole'
                ]
            })
        ]
    }),
      path: "/",
      policies: [
        {
          policyName: "AmazonECSTaskExecutionRolePolicy",
          policyDocument: new IAM.PolicyDocument({
              statements: [
                new IAM.PolicyStatement({
                    effect: IAM.Effect.ALLOW,
                    actions: [
                        // Allow the ECS Tasks to download images from ECR
                        'ecr:GetAuthorizationToken',
                        'ecr:BatchCheckLayerAvailability',
                        'ecr:GetDownloadUrlForLayer',
                        'ecr:BatchGetImage',

                        // Allow the ECS tasks to upload logs to CloudWatch
                        'logs:CreateLogStream',
                        'logs:PutLogEvents'
                    ],
                    resources: ["*"]
                })
              ]
            
          })
        }
      ]
    })

    const address = props.cluster.attrEndpointAddress || "";

    const taskDefinition = new ECS.CfnTaskDefinition(this, 'TaskDefinition', {
      cpu: FARGATE_CPU,
      memory: FARGATE_MEMORY,
      requiresCompatibilities: ["FARGATE"],
      family: "prisma",
      networkMode: "awsvpc",
      executionRoleArn: ecsTaskExecutionRole.ref,
      taskRoleArn: ecsTaskExecutionRole.ref,
      containerDefinitions: [{
        name: "prisma-container",
        essential: true,
        image: ['prismagraphql/prisma',PRISMA_VERSION].join(':'),
        portMappings: [
          {
            containerPort: 60000
          }
        ],
        environment: [{
          name: "PRISMA_CONFIG",
          value: `
          port: 60000
          managementApiSecret: ${process.env.PRISMA_MANAGEMENT_SECRET}
          databases:
            default:
              connector: mysql
              host: ${props.cluster.attrEndpointAddress}
              port: ${props.cluster.attrEndpointPort}
              user: ${process.env.DATABASE_USERNAME}
              password: ${process.env.DATABASE_PASSWORD}
              migrations: true
          `
        },{
            name: "JAVA_OPTS",
            value: JVM_OPTS
        }],
        ulimits: [{
            name: "nofile",
            hardLimit: 1000000,
            softLimit: 1000000
        }],
        logConfiguration: {
            logDriver: "awslogs",
            options: {
                "awslogs-group": this.stackName,
                "awslogs-region": this.region,
                "awslogs-stream-prefix": "prisma",
            }
        }
      }]
    })

    const prismaService = new ECS.CfnService(this, 'PrismaService', {
        cluster: ecsCluster.ref,
        serviceName: "Prisma",
        launchType: "FARGATE",
        desiredCount: 1,
        deploymentConfiguration: {
            maximumPercent: 200,
            minimumHealthyPercent: 50,
        },
        taskDefinition: taskDefinition.ref,
        loadBalancers: [{
            containerName: "prisma-container",
            containerPort: 60000,
            targetGroupArn: prismaTargetGroup.ref
        }],
        networkConfiguration: {
            awsvpcConfiguration: {
                assignPublicIp: "ENABLED",
                securityGroups: [publicLoadBalancerSG.ref],
                subnets: [publicSubnet1.ref, publicSubnet2.ref]
            }
        }
    })
    prismaService.addDependsOn(publicLoadBalancerListener);

    new cdk.CfnOutput(this, 'ClusterName', {
        description: "The name of the ECS cluster",
        value: ecsCluster.ref,
        exportName: [this.stackName, 'ClusterName'].join(':')
    })

    new cdk.CfnOutput(this, 'ExternalUrl', {
        description: "The url of the external load balancer",
        value: ['http://', publicLoadBalancer.attrDnsName].join(''),
        exportName: [this.stackName, 'ExternalUrl'].join(':')
    })
  }
}
