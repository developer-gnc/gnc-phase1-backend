const express = require('express');
const User = require('../models/User');
const router = express.Router();

// Middleware to check if user is authenticated
const isAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ error: 'Not authenticated' });
};

// Get current user profile
router.get('/profile', isAuthenticated, (req, res) => {
  try {
    const user = {
      id: req.user._id,
      email: req.user.email,
      name: req.user.name,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      profilePicture: req.user.profilePicture,
      lastLogin: req.user.lastLogin,
      createdAt: req.user.createdAt
    };
    res.json({ user });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

// Update user profile (limited fields)
router.put('/profile', isAuthenticated, async (req, res) => {
  try {
    const { firstName, lastName } = req.body;
    
    // Validate input
    if (!firstName || !lastName) {
      return res.status(400).json({ error: 'First name and last name are required' });
    }

    const updatedUser = await User.findByIdAndUpdate(
      req.user._id,
      { 
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        name: `${firstName.trim()} ${lastName.trim()}`,
        updatedAt: Date.now()
      },
      { new: true, runValidators: true }
    );

    const user = {
      id: updatedUser._id,
      email: updatedUser.email,
      name: updatedUser.name,
      firstName: updatedUser.firstName,
      lastName: updatedUser.lastName,
      profilePicture: updatedUser.profilePicture,
      lastLogin: updatedUser.lastLogin,
      createdAt: updatedUser.createdAt,
      updatedAt: updatedUser.updatedAt
    };

    res.json({ message: 'Profile updated successfully', user });
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Get all users (admin functionality - you can add role-based access later)
router.get('/all', isAuthenticated, async (req, res) => {
  try {
    const users = await User.find({ isActive: true })
      .select('email name firstName lastName profilePicture lastLogin createdAt')
      .sort({ createdAt: -1 });
    
    res.json({ users });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

module.exports = router;