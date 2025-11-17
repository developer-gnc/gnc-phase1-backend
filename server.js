require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const passport = require('passport');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

const authMiddleware = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const imageRoutes = require('./routes/imageRoutes'); // Updated to match our file
const secureImageRoutes = require('./routes/secureImages'); // Updated to match our file

require('./config/passport');

const app = express();

// Create required directories
const uploadsDir = path.join(__dirname, 'uploads');
const tempImagesDir = path.join(__dirname, 'temp_images');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
if (!fs.existsSync(tempImagesDir)) fs.mkdirSync(tempImagesDir);

// Trust proxy - IMPORTANT for Hostinger
app.set('trust proxy', 1);

// Enhanced Helmet configuration for production
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:", "http:"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  },
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// Rate limiting
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
}));

// CORS - Support multiple origins
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'https://gnc-phase1-frontend.vercel.app',
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'CORS policy does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true
}));

// Body parsing with increased limits for base64 images
app.use(express.json({ limit: '50mb' })); // Increased for base64 images
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Secure image serving with authentication
app.use('/secure-images', secureImageRoutes);

app.use((req, res, next) => {
  console.log(`🔍 ${req.method} ${req.url}`);
  next();
});

// MongoDB Session Store
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGO_URI,
    touchAfter: 24 * 3600,
    crypto: {
      secret: process.env.SESSION_SECRET
    },
    collectionName: 'sessions',
    ttl: 24 * 60 * 60
  }),
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    domain: process.env.COOKIE_DOMAIN || undefined
  },
  proxy: true
}));

app.use(passport.initialize());
app.use(passport.session());

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

// Root route
app.get('/', (req, res) => {
  res.json({
    message: 'GNC Image Processing Backend API',
    version: '2.0.0',
    status: 'running',
    timestamp: new Date().toISOString(),
    features: {
      imageProcessing: true,
      modelSelection: true,
      customPrompts: true,
      batchProcessing: true,
      userIsolation: true,
      parallelProcessing: true,
      authenticationRequired: true
    },
    availableModels: [
      'gemini-2.0-flash',
      'gemini-2.5-flash',
      'gemini-2.5-pro'
    ],
    endpoints: {
      health: '/api/health',
      auth: '/api/auth',
      user: '/api/user',
      dashboard: '/api/dashboard',
      imageProcessing: '/api/images',
      secureImages: '/secure-images (authenticated)'
    },
    changelog: {
      'v2.0.0': [
        'Removed PDF upload dependency',
        'Added direct image upload with page numbers',
        'Added AI model selection (Gemini 2.0 Flash, 1.5 Pro, 1.5 Flash)',
        'Added custom prompt support',
        'Added batch image processing',
        'Maintained user isolation and parallel processing',
        'Enhanced security with authenticated image access'
      ]
    }
  });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/images', imageRoutes); // NEW: Image processing routes

// Dashboard endpoint
app.get('/api/dashboard', authMiddleware.requireAuth, (req, res) => {
  res.json({
    message: 'Welcome to GNC Image Processing Dashboard',
    user: {
      email: req.user.email,
      name: req.user.name
    },
    features: {
      imageProcessing: true,
      modelSelection: true,
      customPrompts: true,
      batchProcessing: true
    },
    availableModels: [
      'gemini-2.0-flash',
      'gemini-2.5-flash',
      'gemini-2.5-pro'
    ]
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK',
    service: 'GNC Image Processing API',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    secure: req.secure,
    protocol: req.protocol,
    features: {
      imageProcessing: true,
      modelSelection: true,
      customPrompts: true,
      batchProcessing: true,
      userIsolation: true,
      parallelProcessing: true,
      authenticationRequired: true
    },
    environment: process.env.NODE_ENV || 'development'
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Error occurred:', {
    message: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    timestamp: new Date().toISOString()
  });

  if (err.name === 'ValidationError') {
    return res.status(400).json({ 
      error: 'Validation error',
      details: err.message
    });
  }

  // Handle payload too large error
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'Payload too large',
      message: 'Image file too large. Please use smaller images or compress them.',
      maxSize: '50MB'
    });
  }

  res.status(500).json({ 
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong. Please try again.'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Not found',
    details: `Route ${req.method} ${req.url} not found`,
    availableEndpoints: [
      'GET /',
      'GET /api/health',
      'GET /api/auth/*',
      'GET /api/user/*',
      'POST /api/images/process-image',
      'POST /api/images/process-batch-images',
      'GET /api/images/available-models',
      'GET /api/dashboard'
    ]
  });
});

const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0';

// Check for SSL certificates and start appropriate server
const sslKeyPath = '/etc/letsencrypt/live/srv1047946.hstgr.cloud/privkey.pem';
const sslCertPath = '/etc/letsencrypt/live/srv1047946.hstgr.cloud/fullchain.pem';

if (fs.existsSync(sslKeyPath) && fs.existsSync(sslCertPath)) {
  // HTTPS Server
  const httpsOptions = {
    key: fs.readFileSync(sslKeyPath),
    cert: fs.readFileSync(sslCertPath)
  };

  https.createServer(httpsOptions, app).listen(PORT, HOST, () => {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`✅ Secure HTTPS server running on https://${HOST}:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Allowed origins: ${allowedOrigins.join(', ')}`);
    console.log('🖼️  IMAGE PROCESSING API v2.0.0 ready!');
    console.log('✅ MongoDB session store active');
    console.log('🔐 Authentication required for all processing');
    console.log('👥 Multi-user isolation ACTIVE');
    console.log('🤖 AI Model Selection: Gemini 2.0 Flash, 2.5 Flash, 2.5 Pro');
    console.log('📝 Prompt from Frontend required');
    console.log('⚡ Batch Processing with parallel execution');
    console.log('🛡️ Secure image serving with authentication');
    console.log('📊 Real-time processing status via SSE');
    console.log(`${'='.repeat(70)}\n`);
  });
} else {
  // HTTP Server (fallback)
  http.createServer(app).listen(PORT, HOST, () => {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`⚠️ HTTP server running on http://${HOST}:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Allowed origins: ${allowedOrigins.join(', ')}`);
    console.log('🖼️  IMAGE PROCESSING API v2.0.0 ready!');
    console.log('✅ MongoDB session store active');
    console.log('🔐 Authentication required for all processing');
    console.log('👥 Multi-user isolation ACTIVE');
    console.log('🤖 AI Model Selection: Gemini 2.0 Flash, 1.5 Pro, 1.5 Flash');
    console.log('📝 Custom Prompt Support enabled');
    console.log('⚡ Batch Processing with parallel execution');
    console.log('🛡️ Secure image serving with authentication');
    console.log('📊 Real-time processing status via SSE');
    console.log('⚠️ Warning: SSL certificates not found. Running on HTTP.');
    console.log(`${'='.repeat(70)}\n`);
  });
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  process.exit(0);
});