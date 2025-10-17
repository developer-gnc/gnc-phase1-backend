const express = require('express');
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');
const router = express.Router();

// Get current user profile
router.get('/profile', requireAuth, (req, res) => {
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

// Update user profile
router.put('/profile', requireAuth, async (req, res) => {
  try {
    const { firstName, lastName } = req.body;
    
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

// Get all users
router.get('/all', requireAuth, async (req, res) => {
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