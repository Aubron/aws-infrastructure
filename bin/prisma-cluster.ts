#!/usr/bin/env node
require('dotenv').config()
import 'source-map-support/register';
import cdk = require('@aws-cdk/core');
import { DatabaseStack } from '../lib/database-stack';
import { PrismaServiceStack } from '../lib/prisma-service-stack';

const createStack = () => {
    const app = new cdk.App();
    const databaseStack = new DatabaseStack(app, 'DatabaseStack');
    const prismaStack = new PrismaServiceStack(app, 'PrismaServiceStack', {
        cluster: databaseStack.cluster
    })
}

createStack();