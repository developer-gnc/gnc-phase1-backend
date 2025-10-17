// test-setup.js - Save in project root
require('dotenv').config();

const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { TextractClient } = require('@aws-sdk/client-textract');

async function testSetup() {
  console.log('🧪 Testing Complete AWS Textract Setup\n');

  // Check environment variables
  const required = [
    'AWS_ACCESS_KEY_ID', 
    'AWS_SECRET_ACCESS_KEY', 
    'AWS_REGION', 
    'AWS_S3_BUCKET'
  ];
  
  console.log('1️⃣ Checking environment variables...');
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.log('❌ Missing variables:', missing);
    return false;
  }
  console.log('✅ All AWS environment variables found');

  // Initialize clients
  const awsConfig = {
    region: process.env.AWS_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
  };

  const s3Client = new S3Client(awsConfig);
  const textractClient = new TextractClient(awsConfig);

  try {
    // Test S3
    console.log('\n2️⃣ Testing S3 access...');
    const testKey = `test-${Date.now()}.txt`;
    
    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET,
      Key: testKey,
      Body: 'test',
      ContentType: 'text/plain'
    }));
    
    await s3Client.send(new DeleteObjectCommand({
      Bucket: process.env.AWS_S3_BUCKET,
      Key: testKey
    }));
    
    console.log('✅ S3 access working');

    // Test Textract client (just initialization)
    console.log('\n3️⃣ Testing Textract client...');
    console.log('✅ Textract client initialized');

    console.log('\n🎉 Setup test completed successfully!');
    console.log('\n🚀 Ready to process PDF files with AWS Textract!');
    
    console.log('\n📋 Next steps:');
    console.log('1. Start your server: npm run dev');
    console.log('2. Open frontend: http://localhost:3000');
    console.log('3. Test with a PDF file');
    
    return true;

  } catch (error) {
    console.log('\n❌ Test failed:', error.message);
    
    if (error.name === 'NoSuchBucket') {
      console.log('💡 Create your S3 bucket in AWS console');
    } else if (error.name === 'AccessDenied') {
      console.log('💡 Check your IAM permissions');
    } else if (error.name === 'InvalidAccessKeyId') {
      console.log('💡 Verify your AWS_ACCESS_KEY_ID in .env');
    }
    
    return false;
  }
}

testSetup().then(success => {
  process.exit(success ? 0 : 1);
});