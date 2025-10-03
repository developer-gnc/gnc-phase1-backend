const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  googleId: { 
    type: String, 
    required: true, 
    unique: true 
  },
  email: {
    type: String,
    required: true,
    unique: true,
    validate: {
      validator: (email) => email.endsWith('@gncgroup.ca'),
      message: 'Only @gncgroup.ca emails allowed'
    }
  },
  name: { 
    type: String, 
    required: true 
  },
  firstName: {
    type: String
  },
  lastName: {
    type: String
  },
  profilePicture: {
    type: String
  },
  lastLogin: {
    type: Date,
    default: Date.now
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, { timestamps: true });

module.exports = mongoose.model('GNCUser', userSchema);