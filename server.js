require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const storageConfig = require('./config/storage');
const mikrotikConfig = require('./config/mikrotik');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Routes Static File
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ==========================================
// API ROUTES
// ==========================================

// 1. Register new user
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, phone, username, password } = req.body;
    
    // Validate input
    if (!name || !email || !phone || !username || !password) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }
    
    // Check if username already exists
    const existingUser = await storageConfig.getUserByUsername(username);
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'Username already exists' });
    }
    
    // Add user to storage
    const newUser = await storageConfig.addUser({ name, email, phone, username, password });
    
    res.json({ success: true, message: 'Registration successful. Please wait for admin approval.', user: newUser });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ success: false, message: error.message || 'Registration failed' });
  }
});

// 2. Get all users (Mendukung Endpoint /api/users DANDAN /api/admin/users)
const getAllUsersHandler = async (req, res) => {
  try {
    const users = await storageConfig.getAllUsers();
    
    // Ambil data statistik dari MikroTik dengan Try-Catch Aman (Aman di Vercel Serverless)
    let mikrotikStats = [];
    try {
      if (mikrotikConfig.getUsersStats && typeof mikrotikConfig.getUsersStats === 'function') {
        mikrotikStats = await mikrotikConfig.getUsersStats();
      }
    } catch (mErr) {
      console.warn('MikroTik unreachable (ignoring stats):', mErr.message);
    }

    // Gabungkan data user storage dengan statistik MikroTik
    const enrichedUsers = (users || []).map(user => {
      const stats = mikrotikStats.find(s => s.name === user.username || s.user === user.username) || {};
      
      return {
        ...user,
        bytesIn: parseInt(stats['bytes-in'] || stats.bytesIn || 0),
        bytesOut: parseInt(stats['bytes-out'] || stats.bytesOut || 0),
        uptime: stats.uptime || 'Off'
      };
    });

    res.json({ success: true, users: enrichedUsers });
  } catch (error) {
    console.error('Error getting users:', error);
    res.status(500).json({ success: false, message: 'Failed to get users', users: [] });
  }
};

app.get('/api/users', getAllUsersHandler);
app.get('/api/admin/users', getAllUsersHandler); // Endpoint khusus yang dipanggil oleh admin.html

// 3. Approve user (Dukungan penuh untuk /api/approve dan /api/admin/approve)
const approveHandler = async (req, res) => {
  try {
    const { username, adminName } = req.body;
    
    if (!username) {
      return res.status(400).json({ success: false, message: 'Username is required' });
    }
    
    // Update user status in storage
    const updatedUser = await storageConfig.approveUser(username, adminName || 'Erfin');
    
    // Add user to Mikrotik hotspot (Aman jika MikroTik offline)
    try {
      const userData = await storageConfig.getUserByUsername(username);
      if (userData && mikrotikConfig.addUserToHotspot) {
        await mikrotikConfig.addUserToHotspot(userData.username, userData.password);
      }
    } catch (mErr) {
      console.warn('MikroTik Add User skipped/failed:', mErr.message);
    }
    
    res.json({ success: true, message: 'User approved successfully', user: updatedUser });
  } catch (error) {
    console.error('Approval error:', error);
    res.status(500).json({ success: false, message: 'Approval failed' });
  }
};

app.post('/api/approve', approveHandler);
app.post('/api/admin/approve', approveHandler);

// 4. Reject user (Dukungan penuh untuk /api/reject dan /api/admin/reject)
const rejectHandler = async (req, res) => {
  try {
    const { username, adminName } = req.body;
    
    if (!username) {
      return res.status(400).json({ success: false, message: 'Username is required' });
    }
    
    const updatedUser = await storageConfig.rejectUser(username, adminName || 'Erfin');
    
    res.json({ success: true, message: 'User rejected successfully', user: updatedUser });
  } catch (error) {
    console.error('Rejection error:', error);
    res.status(500).json({ success: false, message: 'Rejection failed' });
  }
};

app.post('/api/reject', rejectHandler);
app.post('/api/admin/reject', rejectHandler);

// 5. Delete user (Dukungan DELETE & POST untuk /api/admin/delete)
const deleteHandler = async (req, res) => {
  try {
    const username = req.params.username || req.body.username;
    
    if (!username) {
      return res.status(400).json({ success: false, message: 'Username is required' });
    }

    await storageConfig.deleteUser(username);
    
    try {
      if (mikrotikConfig.removeUserFromHotspot) {
        await mikrotikConfig.removeUserFromHotspot(username);
      }
    } catch (mErr) {
      console.warn('MikroTik Delete User skipped/failed:', mErr.message);
    }
    
    res.json({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    console.error('Deletion error:', error);
    res.status(500).json({ success: false, message: 'Deletion failed' });
  }
};

app.delete('/api/users/:username', deleteHandler);
app.post('/api/admin/delete', deleteHandler);

// Validate login
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username and password are required' });
    }
    
    // Get user from storage
    const user = await storageConfig.getUserByUsername(username);
    
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    // Check if password matches
    if (user.password !== password) {
      return res.status(401).json({ success: false, message: 'Invalid password' });
    }
    
    // Check if user is approved
    if (user.status !== 'approved') {
      return res.status(403).json({ success: false, message: 'User not approved yet' });
    }
    
    // Validate with Mikrotik (dengan fallback jika Mikrotik offline)
    let mikrotikResult = { success: true };
    try {
      if (mikrotikConfig.validateLogin) {
        mikrotikResult = await mikrotikConfig.validateLogin(username, password);
      }
    } catch (mErr) {
      console.warn('MikroTik login validation skipped:', mErr.message);
    }
    
    if (mikrotikResult.success) {
      res.json({ success: true, message: 'Login successful', user: { name: user.name, username: user.username } });
    } else {
      res.status(401).json({ success: false, message: mikrotikResult.message });
    }
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: 'Login failed' });
  }
});

// Check user status
app.get('/api/status/:username', async (req, res) => {
  try {
    const { username } = req.params;
    const user = await storageConfig.getUserByUsername(username);
    
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    
    res.json({ success: true, status: user.status });
  } catch (error) {
    console.error('Status check error:', error);
    res.status(500).json({ success: false, message: 'Status check failed' });
  }
});

// Admin authentication
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  
  if (password === process.env.ADMIN_PASSWORD) {
    res.json({ success: true, message: 'Admin login successful' });
  } else {
    res.status(401).json({ success: false, message: 'Invalid admin password' });
  }
});

// Export app handler untuk Vercel Serverless
module.exports = app;

// Jalankan server jika running di lokal (npm start / node server.js)
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}
 
