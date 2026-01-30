# GNC Group Invoice Extractor - Backend API Documentation

## Project Overview

The GNC Group Invoice Extractor backend is a Node.js/Express application that provides AI-powered image analysis and data extraction services. It features secure authentication, multi-user session isolation, parallel processing with multiple AI models, and comprehensive API endpoints for invoice data extraction.

### Deployment Information
- **Hosting Platform**: Hostinger VPS
- **Production URL**: https://srv1047946.hstgr.cloud:5000
- **Server Configuration**: Ubuntu 24 with HTTPS/SSL certificates
- **Database**: MongoDB Atlas cloud instance
- **Environment**: Production server with auto-scaling capabilities

## Technology Stack

### Core Technologies
- **Node.js 18+** - Runtime environment
- **Express.js** - Web application framework
- **MongoDB** - Document database with Mongoose ODM
- **Passport.js** - Authentication middleware
- **Google Generative AI** - AI-powered image analysis
- **JWT** - JSON Web Token authentication

### Key Dependencies
- express: Web application framework
- mongoose: MongoDB object modeling
- passport & passport-google-oauth20: OAuth authentication
- jsonwebtoken: JWT implementation
- @google/generative-ai: Google AI integration
- cors: Cross-origin resource sharing
- helmet: Security middleware
- express-rate-limit: Rate limiting

## Application Architecture

### Directory Structure
```
backend/
├── config/
│   └── passport.js          # Passport OAuth configuration
├── controllers/
│   └── imageController.js   # Image processing logic
├── middleware/
│   └── auth.js             # Authentication middleware
├── models/
│   └── User.js             # User data model
├── routes/
│   ├── auth.js             # Authentication routes
│   ├── imageRoutes.js      # Image processing routes
│   ├── secureImages.js     # Secure image serving
│   └── user.js             # User management routes
├── services/
│   ├── calculationService.js # Data processing service
│   ├── geminiService.js     # AI analysis service
│   ├── sessionStore.js      # Session management
│   └── RequestQueue.js      # Rate limiting queue
└── server.js               # Application entry point
```

## Authentication System

### Google OAuth Integration
- Supports Google OAuth 2.0 for secure authentication
- Domain restriction to @gncgroup.ca email addresses only
- Automatic user creation and profile management
- JWT token generation for subsequent API requests

### Security Features
- JWT-based session management with 7-day expiration
- User session validation on each request
- Account activation/deactivation support
- Rate limiting per user to prevent abuse
- Secure password-less authentication via Google

### Access Control
- All image processing endpoints require authentication
- User-specific session isolation
- Image access validation based on ownership
- Cross-origin resource sharing (CORS) configuration

## AI-Powered Analysis Service

### Multi-Model Support
The system supports multiple Google Gemini AI models:
- **Gemini 2.0 Flash** - Fast and efficient (default)
- **Gemini 2.5 Flash** - Enhanced accuracy with improved speed
- **Gemini 2.5 Pro** - Maximum accuracy for complex documents

### Ultra-Fast Parallel Processing
- Supports up to 10 concurrent API keys for maximum throughput
- Intelligent load balancing across available keys
- Advanced rate limiting with burst protection
- Automatic retry mechanisms with fallback strategies
- Concurrent processing of up to 80 images simultaneously (8x per key)

### Performance Optimization
- Smart key selection algorithm based on current usage
- Burst limit protection (10 requests per 10-second window)
- Rate limit management (60 requests per minute per key)
- Automatic queue management and request distribution
- Real-time performance monitoring and reporting

## API Endpoints

### Authentication Endpoints

#### POST /api/auth/google
Initiates Google OAuth authentication flow
- Redirects to Google OAuth consent screen
- Supports account selection prompt
- Handles domain validation

#### GET /api/auth/google/callback
Handles OAuth callback from Google
- Validates user domain restrictions
- Creates or updates user profile
- Generates JWT token
- Redirects to frontend with token

#### GET /api/auth/status
Validates current authentication status
- Verifies JWT token validity
- Returns user information if authenticated
- Handles token expiration gracefully

#### POST /api/auth/logout
Logs out current user session
- Clears server-side session data
- Returns success confirmation

### User Management Endpoints

#### GET /api/user/profile
Retrieves current user profile information
- Returns user details and preferences
- Includes last login timestamp
- Authentication required

#### PUT /api/user/profile
Updates user profile information
- Allows updating first name and last name
- Validates input data
- Returns updated profile

#### GET /api/user/all
Retrieves list of all active users
- Returns user directory
- Includes basic profile information
- Admin functionality for user management

### Image Processing Endpoints

#### POST /api/images/process-image
Processes a single image for data extraction
- Accepts base64 encoded image data
- Requires custom prompt from frontend
- Supports AI model selection
- Returns extracted data in structured format

#### POST /api/images/process-batch-images
Processes multiple images in parallel
- Server-Sent Events (SSE) for real-time progress
- Supports concurrent processing of large batches
- Progress tracking and error reporting
- Automatic session management

#### GET /api/images/available-models
Returns list of supported AI models
- Model descriptions and capabilities
- Default model recommendation
- Performance characteristics

#### POST /api/images/validate-model
Validates AI model selection
- Checks model availability
- Returns validation status
- Provides alternative suggestions

#### GET /api/images/health
Health check for image processing service
- Service status and capabilities
- Performance metrics
- Feature availability

### Secure Image Serving

#### GET /secure-images/:filename
Serves processed images with authentication
- Token-based access control
- User ownership validation
- Secure file path verification
- Appropriate caching headers

## Data Models

### User Model
User profiles with Google OAuth integration:
- Google ID for unique identification
- Email validation with domain restrictions
- Profile information (name, picture, login history)
- Account status management
- Automatic timestamps for tracking

## Session Management

### Multi-User Isolation
- Individual session tracking per user
- Image ownership validation
- Session-based file access control
- Automatic cleanup of expired sessions

### Session Features
- User-specific session creation
- Image registration and ownership tracking
- Session validation for security
- Configurable session expiration (2 hours default)

## Error Handling and Monitoring

### Comprehensive Error Management
- Structured error responses with appropriate HTTP status codes
- Detailed error logging for debugging
- Graceful handling of AI service failures
- User-friendly error messages

### Performance Monitoring
- Real-time processing statistics
- Success/failure rate tracking
- Response time monitoring
- Resource usage optimization

## Security Implementation

### Data Protection
- HTTPS enforcement in production
- Helmet.js security headers
- Rate limiting to prevent abuse
- Input validation and sanitization

### Authentication Security
- JWT token validation on each request
- Token expiration handling
- Secure session management
- User domain restrictions

### File Security
- Secure file path validation
- User-based access control
- Temporary file management
- Directory traversal protection

## Deployment Configuration

### Environment Variables
- GOOGLE_CLIENT_ID: OAuth client identifier
- GOOGLE_CLIENT_SECRET: OAuth client secret
- SESSION_SECRET: JWT signing secret
- MONGO_URI: MongoDB connection string
- BACKEND_URL: Server base URL
- FRONTEND_URL: Client application URL
- GEMINI_API_KEY_1 through GEMINI_API_KEY_10: AI service keys

### Production Setup
- SSL certificate management
- HTTPS/HTTP server configuration
- MongoDB session store
- Cross-origin resource sharing
- Rate limiting configuration

### Server Requirements
- Node.js 18 or higher
- MongoDB instance
- SSL certificates for HTTPS
- Sufficient memory for image processing
- Network connectivity for AI services

## Performance Specifications

### Processing Capabilities
- Up to 80 concurrent image analyses
- Processing speed: 60+ pages per minute
- Support for images up to 50MB
- Batch processing of unlimited images

### Scalability Features
- Horizontal scaling support
- Load balancing across API keys
- Automatic resource optimization
- Session-based isolation

## API Response Formats

### Standard Success Response
All successful API responses follow a consistent format with status indicators, data payloads, timestamps, and user attribution.

### Error Response Format
Error responses include appropriate HTTP status codes, error types, descriptive messages, and optional retry information.

### Progress Updates (SSE)
Real-time processing updates via Server-Sent Events include progress percentages, completed items, processing status, and timing information.

## Integration Guidelines

### Frontend Integration
- JWT token management in request headers
- Error handling for authentication failures
- Progress monitoring via SSE connections
- File upload optimization for large images

### Third-Party Integration
- Google OAuth configuration
- AI service key management
- Database connection setup
- SSL certificate installation

## Monitoring and Maintenance

### Health Monitoring
- Regular health check endpoints
- Performance metric collection
- Error rate tracking
- Resource usage monitoring

### Maintenance Tasks
- Session cleanup automation
- Temporary file management
- Log rotation and archival
- Database optimization

## Troubleshooting Guide

### Common Issues
- Authentication failures and domain restrictions
- AI service rate limiting and quota management
- Image processing errors and recovery
- Database connection problems

### Debug Information
- Comprehensive logging system
- Request/response tracking
- Performance bottleneck identification
- Error pattern analysis

## Conclusion

This backend system provides a robust, secure, and scalable foundation for AI-powered invoice data extraction with enterprise-grade features and comprehensive API coverage. The system is hosted on Hostinger VPS with HTTPS/SSL certificates and connects to MongoDB Atlas for data persistence, ensuring reliable and secure operation in a production environment.
