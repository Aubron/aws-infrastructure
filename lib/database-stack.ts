import SNS = require('@aws-cdk/aws-sns');
import EC2 = require('@aws-cdk/aws-ec2');
import RDS = require('@aws-cdk/aws-rds');
import cdk = require('@aws-cdk/core');
import CloudWatch = require('@aws-cdk/aws-cloudwatch');
import { DATABASE_NAME } from '../config';


export class DatabaseStack extends cdk.Stack {
  public readonly cluster: RDS.CfnDBCluster
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    

    const stackAlarmTopic = new SNS.Topic(this,'StackAlarmTopic',{
      displayName: "Stack Alarm Topic"
    })
    

    

    const VPC = new EC2.CfnVPC(this, 'VPC', {
      cidrBlock: "10.192.0.0/16",
      enableDnsHostnames: true,
      enableDnsSupport: true,
    })

    // create subnets to launch on
    const publicSubnet1 = new EC2.CfnSubnet(this, 'PublicSubnet1', {
      vpcId: VPC.ref,
      availabilityZone: "us-east-2b",
      cidrBlock: "10.192.12.0/24",
      mapPublicIpOnLaunch: true,
      tags: [
        new cdk.Tag("Name",`${DATABASE_NAME} Public Subnet (AZ1)`)
      ]
    })

    const publicSubnet2 = new EC2.CfnSubnet(this, 'PublicSubnet2', {
      vpcId: VPC.ref,
      availabilityZone: "us-east-2a",
      cidrBlock: "10.192.13.0/24",
      mapPublicIpOnLaunch: true,
      tags: [
        new cdk.Tag("Name",`${DATABASE_NAME} Public Subnet (AZ2)`)
      ]
    })

    const dbSubnetGroup = new RDS.CfnDBSubnetGroup(this, 'DatabaseSubnetGroup',{
      dbSubnetGroupDescription: "CloudFormation managed DB subnet group",
      subnetIds: [
        publicSubnet1.ref,
        publicSubnet2.ref
      ]
    })

    const parameterGroup = new RDS.CfnDBParameterGroup(this, 'ParameterGroup', {
      description: "Prisma DB parameter group",
      family: 'aurora-mysql5.7',
      parameters: {
        max_connections: "300"
      }
    })

    

    const databaseSecurityGroup = new EC2.CfnSecurityGroup(this, 'DatabaseSecurityGroup', {
      vpcId: VPC.ref,
      groupDescription: "Access to database",
      securityGroupIngress: [
        {
          cidrIp: "0.0.0.0/0",
          fromPort: 3306,
          toPort: 3306,
          ipProtocol: "tcp"
        }
      ],
      tags: [
        new cdk.Tag("Name", `${DATABASE_NAME}-security-group`)
      ]
    })

    const databaseCluster = new RDS.CfnDBCluster(this, 'DatabaseCluster', {
      masterUsername: process.env.DATABASE_USERNAME,
      masterUserPassword: process.env.DATABASE_PASSWORD,
      engine: "aurora-mysql",
      backupRetentionPeriod: 35,
      preferredBackupWindow: "02:00-03:00",
      preferredMaintenanceWindow: "mon:03:00-mon:04:00",
      dbSubnetGroupName: dbSubnetGroup.ref,
      vpcSecurityGroupIds: [
        databaseSecurityGroup.ref
      ],
      dbClusterParameterGroupName: "default.aurora-mysql5.7"
    })
    this.cluster = databaseCluster

    const databaseInstance = new RDS.CfnDBInstance(this, 'DatabaseInstance', {
      engine: "aurora-mysql",
      dbClusterIdentifier: databaseCluster.ref,
      dbInstanceClass: "db.t2.small",
      dbSubnetGroupName: dbSubnetGroup.ref,
      dbParameterGroupName: parameterGroup.ref,
      publiclyAccessible: true,
      dbInstanceIdentifier: DATABASE_NAME,
    })

    const databaseCpuAlarm = new CloudWatch.CfnAlarm(this, 'DatabaseCPUAlarm', {
      alarmDescription: "Primary database CPU utilization is over 80%",
      namespace: "AWS/RDS",
      metricName: "CPUUtilization",
      unit: "Percent",
      statistic: "Average",
      period: 300,
      evaluationPeriods: 2,
      threshold: 80,
      comparisonOperator: "GreaterThanOrEqualToThreshold",
      dimensions: [
        {
          name: "DBInstanceIdentifier",
          value: databaseInstance.ref
        }
      ],
      alarmActions: [
        stackAlarmTopic.topicArn
      ],
      insufficientDataActions: [
        stackAlarmTopic.topicArn
      ]
    })

    const databaseMemoryAlarm = new CloudWatch.CfnAlarm(this, 'DatabaseMemoryAlarm', {
      alarmDescription: "Primary database freeable memory is under 700MB",
      namespace: "AWS/RDS",
      metricName: "FreeableMemory",
      unit: "Bytes",
      statistic: "Average",
      period: 300,
      evaluationPeriods: 2,
      threshold: 700000000,
      comparisonOperator: "LessThanOrEqualToThreshold",
      dimensions: [
        {
          name: "DBInstanceIdentifier",
          value: databaseInstance.ref
        }
      ],
      alarmActions: [
        stackAlarmTopic.topicArn
      ],
      insufficientDataActions: [
        stackAlarmTopic.topicArn
      ],
      okActions: [
        stackAlarmTopic.topicArn
      ]
    })

    const internetGateway = new EC2.CfnInternetGateway(this, 'InternetGateway', {
      tags: [
        new cdk.Tag("Name", DATABASE_NAME)
      ]
    })

    const internetGatewayAttachment = new EC2.CfnVPCGatewayAttachment(this, 'InternetGatewayAttachment', {
      internetGatewayId: internetGateway.ref,
      vpcId: VPC.ref
    })

    const publicRouteTable = new EC2.CfnRouteTable(this, 'PublicRouteTable', {
      vpcId: VPC.ref,
      tags: [
        new cdk.Tag("Name", `${DATABASE_NAME} Public Routes`)
      ]
    })

    const defaultPublicRoute = new EC2.CfnRoute(this, 'DefaultPublicRoute', {
      routeTableId: publicRouteTable.ref,
      destinationCidrBlock: "0.0.0.0/0",
      gatewayId: internetGateway.ref,
    })

    defaultPublicRoute.addDependsOn(internetGatewayAttachment);

    const publicSubnet1RouteTableAssociation = new EC2.CfnSubnetRouteTableAssociation(this, 'PublicSubnet1RouteTableAssociation', {
      routeTableId: publicRouteTable.ref,
      subnetId: publicSubnet1.ref
    })
    const publicSubnet2RouteTableAssociation = new EC2.CfnSubnetRouteTableAssociation(this, 'PublicSubnet2RouteTableAssociation', {
      routeTableId: publicRouteTable.ref,
      subnetId: publicSubnet2.ref
    })
    
    new cdk.CfnOutput(this, 'DatabaseEndpoint', {
      description: "The database endpoint",
      value: databaseCluster.attrEndpointAddress
    })

    new cdk.CfnOutput(this, 'DatabasePort', {
      description: "The database port",
      value: databaseCluster.attrEndpointPort
    })

  }
}
