require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const storageConfig = require('./config/storage');
const mikrotikConfig = require('./config/mikrotik');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware CORS & Parser
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Debug log incoming request
app.use((req, res, next) => {
    console.log(`[REQ] Method: ${req.method} | URL: ${req.url}`);
    next();
});

// ==========================================
// FAIL-SAFE: PENGAMAN OTOMATIS UNTUK REGISTER
// ==========================================
app.post('*', async (req, res, next) => {
    const isRegisterPayload = req.body && req.body.username && req.body.password && req.body.email && req.body.name;
    const isRegisterPath = req.url.includes('register') || req.url === '/server.js' || req.url === '/api';

    if (isRegisterPayload && isRegisterPath && !req.url.includes('login') && !req.url.includes('approve') && !req.url.includes('reject')) {
        try {
            const { name, email, phone, username, password, mac } = req.body;
            
            if (!name || !email || !phone || !username || !password) {
                return res.status(400).json({ success: false, message: 'All fields are required' });
            }
            
            const existingUser = await storageConfig.getUserByUsername(username);
            if (existingUser) {
                return res.status(400).json({ success: false, message: 'Username already exists' });
            }
            
            const newUser = await storageConfig.addUser({ name, email, phone, username, password, mac: mac || '', status: 'pending' });
            console.log(`[FAIL-SAFE REGISTER SUCCESS]: User ${username} registered.`);
            return res.json({ success: true, message: 'Registration successful. Please wait for admin approval.', user: newUser });
        } catch (error) {
            console.error('Registration fail-safe error:', error);
            return res.status(500).json({ success: false, message: error.message || 'Registration failed' });
        }
    }
    next();
});

// ==========================================
// 1. API ROUTES UTAMA
// ==========================================

app.post('/api/register', async (req, res) => {
    try {
        const { name, email, phone, username, password, mac } = req.body;
        if (!name || !email || !phone || !username || !password) {
            return res.status(400).json({ success: false, message: 'All fields are required' });
        }
        
        const existingUser = await storageConfig.getUserByUsername(username);
        if (existingUser) {
            return res.status(400).json({ success: false, message: 'Username already exists' });
        }
        
        // Memastikan status awal adalah pending
        const newUser = await storageConfig.addUser({ 
            name, 
            email, 
            phone, 
            username, 
            password, 
            mac: mac || '', 
            status: 'pending' 
        });
        
        console.log(`[API REGISTER SUCCESS]: User ${username} added to storage.`);
        return res.json({ success: true, message: 'Registration successful. Please wait for admin approval.', user: newUser });
    } catch (error) {
        console.error('Registration error:', error);
        return res.status(500).json({ success: false, message: error.message || 'Registration failed' });
    }
});

const getAllUsersHandler = async (req, res) => {
    try {
        const users = await storageConfig.getAllUsers();
        let mikrotikStats = [];
        try {
            if (mikrotikConfig.getUsersStats && typeof mikrotikConfig.getUsersStats === 'function') {
                mikrotikStats = await mikrotikConfig.getUsersStats();
            }
        } catch (mErr) {
            console.warn('MikroTik unreachable (ignoring stats):', mErr.message);
        }

        const enrichedUsers = (users || []).map(user => {
            const stats = mikrotikStats.find(s => s.name === user.username || s.user === user.username) || {};
            return {
                ...user,
                bytesIn: parseInt(stats['bytes-in'] || stats.bytesIn || 0),
                bytesOut: parseInt(stats['bytes-out'] || stats.bytesOut || 0),
                uptime: stats.uptime || 'Off'
            };
        });

        return res.json({ success: true, users: enrichedUsers });
    } catch (error) {
        console.error('Error getting users:', error);
        return res.status(500).json({ success: false, message: 'Failed to get users', users: [] });
    }
};

app.get('/api/users', getAllUsersHandler);
app.get('/api/admin/users', getAllUsersHandler);

const approveHandler = async (req, res) => {
    try {
        const { username, adminName } = req.body;
        if (!username) {
            return res.status(400).json({ success: false, message: 'Username is required' });
        }
        const updatedUser = await storageConfig.approveUser(username, adminName || 'Admin');
        try {
            const userData = await storageConfig.getUserByUsername(username);
            if (userData && mikrotikConfig.addUserToHotspot) {
                await mikrotikConfig.addUserToHotspot(userData.username, userData.password);
            }
        } catch (mErr) {
            console.warn('MikroTik Add User skipped/failed:', mErr.message);
        }
        return res.json({ success: true, message: 'User approved successfully', user: updatedUser });
    } catch (error) {
        console.error('Approval error:', error);
        return res.status(500).json({ success: false, message: 'Approval failed' });
    }
};

app.post('/api/approve', approveHandler);
app.post('/api/admin/approve', approveHandler);

const rejectHandler = async (req, res) => {
    try {
        const { username, adminName } = req.body;
        if (!username) {
            return res.status(400).json({ success: false, message: 'Username is required' });
        }
        const updatedUser = await storageConfig.rejectUser(username, adminName || 'Admin');
        return res.json({ success: true, message: 'User rejected successfully', user: updatedUser });
    } catch (error) {
        console.error('Rejection error:', error);
        return res.status(500).json({ success: false, message: 'Rejection failed' });
    }
};

app.post('/api/reject', rejectHandler);
app.post('/api/admin/reject', rejectHandler);

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
        return res.json({ success: true, message: 'User deleted successfully' });
    } catch (error) {
        console.error('Deletion error:', error);
        return res.status(500).json({ success: false, message: 'Deletion failed' });
    }
};

app.delete('/api/users/:username', deleteHandler);
app.post('/api/admin/delete', deleteHandler);

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ success: false, message: 'Username and password are required' });
        }
        const user = await storageConfig.getUserByUsername(username);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        if (user.password !== password) {
            return res.status(401).json({ success: false, message: 'Invalid password' });
        }
        if (user.status !== 'approved') {
            return res.status(403).json({ success: false, message: 'User not approved yet' });
        }
        let mikrotikResult = { success: true };
        try {
            if (mikrotikConfig.validateLogin) {
                mikrotikResult = await mikrotikConfig.validateLogin(username, password);
            }
        } catch (mErr) {
            console.warn('MikroTik login validation skipped:', mErr.message);
        }
        if (mikrotikResult.success) {
            return res.json({ success: true, message: 'Login successful', user: { name: user.name, username: user.username } });
        } else {
            return res.status(401).json({ success: false, message: mikrotikResult.message });
        }
    } catch (error) {
        console.error('Login error:', error);
        return res.status(500).json({ success: false, message: 'Login failed' });
    }
});

app.get('/api/status/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const user = await storageConfig.getUserByUsername(username);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        return res.json({ success: true, status: user.status });
    } catch (error) {
        console.error('Status check error:', error);
        return res.status(500).json({ success: false, message: 'Status check failed' });
    }
});

app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === process.env.ADMIN_PASSWORD) {
        return res.json({ success: true, message: 'Admin login successful' });
    } else {
        return res.status(401).json({ success: false, message: 'Invalid admin password' });
    }
});

// ==========================================
// 2. STATIC HTML ROUTES
// ==========================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Fallback route
app.use((req, res) => {
    res.status(404).json({ success: false, message: 'Endpoint not found: ' + req.originalUrl });
});

// Export app untuk Vercel Serverless
module.exports = app;

// Listener untuk lingkungan lokal
if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
}
