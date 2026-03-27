require('dotenv').config();

const env = {
  port: parseInt(process.env.PORT, 10) || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    name: process.env.DB_NAME || 'shoe_erp',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'dev-secret-change-me',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change-me',
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },

  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  },

  storage: {
    type: process.env.STORAGE_TYPE || 'local',
    uploadDir: process.env.UPLOAD_DIR || 'uploads',
    s3: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      region: process.env.AWS_REGION || 'eu-west-1',
      bucket: process.env.AWS_S3_BUCKET,
    },
  },
};

// Block startup if production secrets are still defaults
if (env.nodeEnv === 'production') {
  const problems = [];
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'dev-secret-change-me') {
    problems.push('JWT_SECRET');
  }
  if (!process.env.JWT_REFRESH_SECRET || process.env.JWT_REFRESH_SECRET === 'dev-refresh-secret-change-me') {
    problems.push('JWT_REFRESH_SECRET');
  }
  if (!process.env.DB_PASSWORD) {
    problems.push('DB_PASSWORD');
  }
  if (problems.length > 0) {
    throw new Error(`SECURITY: Missing or insecure environment variables in production: ${problems.join(', ')}`);
  }
}

// Block startup if S3 is selected but credentials are missing
if (env.storage.type === 's3') {
  const missing = ['accessKeyId', 'secretAccessKey', 'bucket'].filter(k => !env.storage.s3[k]);
  if (missing.length > 0) {
    throw new Error(`S3 storage selected but missing config: ${missing.join(', ')}. Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_S3_BUCKET.`);
  }
}

module.exports = env;
