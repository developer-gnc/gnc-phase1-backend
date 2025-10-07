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
const pdfRoutes = require('./routes/pdf');

require('./config/passport');

const app = express();

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
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

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
  process.env.FRONTEND_URL // Add your production frontend URL via env variable
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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/images', express.static('temp_images'));

// MongoDB Session Store - Fixes MemoryStore warning
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGO_URI,
    touchAfter: 24 * 3600, // lazy session update (24 hours)
    crypto: {
      secret: process.env.SESSION_SECRET
    },
    collectionName: 'sessions',
    ttl: 24 * 60 * 60 // Session TTL (1 day in seconds)
  }),
  cookie: {
    secure: process.env.NODE_ENV === 'production', // Will be true on Hostinger
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    domain: process.env.COOKIE_DOMAIN || undefined // Optional: set if needed
  },
  proxy: true // Important for HTTPS behind proxy
}));

app.use(passport.initialize());
app.use(passport.session());

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api', pdfRoutes);

app.get('/api/dashboard', authMiddleware.requireAuth, (req, res) => {
  res.json({
    message: 'Welcome to dashboard',
    user: {
      email: req.user.email,
      name: req.user.name
    }
  });
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK',
    timestamp: new Date().toISOString(),
    secure: req.secure,
    protocol: req.protocol
  });
});

app.use((err, req, res, next) => {
  console.error('Error occurred:', {
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

  res.status(500).json({ 
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong. Please try again.'
  });
});

app.use((req, res) => {
  res.status(404).json({ 
    error: 'Not found',
    details: `Route ${req.method} ${req.url} not found`
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
    console.log(`✓ Secure HTTPS server running on https://${HOST}:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV}`);
    console.log(`Allowed origins: ${allowedOrigins.join(', ')}`);
    console.log('PDF processing and authentication ready!');
    console.log('MongoDB session store active');
  });
} else {
  // HTTP Server (fallback)
  http.createServer(app).listen(PORT, HOST, () => {
    console.log(`⚠ HTTP server running on http://${HOST}:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV}`);
    console.log(`Allowed origins: ${allowedOrigins.join(', ')}`);
    console.log('PDF processing and authentication ready!');
    console.log('MongoDB session store active');
    console.log('⚠ Warning: SSL certificates not found. Running on HTTP.');
  });
}