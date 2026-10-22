const { Redis } = require('@upstash/redis');

class StorageConfig {
  constructor() {
    this.redis = Redis.fromEnv();
    this.userIndexKey = 'hotspot_users_index'; // Menyimpan daftar username
  }

  // Helper untuk membuat key unik per user
  getUserKey(username) {
    return `hotspot_user:${username}`;
  }

  async addUser(userData) {
    try {
      const username = userData.username;
      const userKey = this.getUserKey(username);

      // Cek apakah username sudah ada
      const existingUser = await this.redis.get(userKey);
      if (existingUser) {
        throw new Error('Username sudah terdaftar');
      }

      const timestamp = new Date().toISOString();
      const newUser = {
        id: Date.now().toString(),
        timestamp,
        name: userData.name,
        email: userData.email,
        phone: userData.phone,
        username: username,
        password: userData.password, // Catatan: Sebaiknya di-hash menggunakan bcrypt di production
        status: 'pending',
        approvedAt: '',
        approvedBy: ''
      };

      // Simpan data user ke key individu
      await this.redis.set(userKey, JSON.stringify(newUser));

      // Tambahkan username ke dalam Set index utama agar mudah dilacak
      await this.redis.sadd(this.userIndexKey, username);

      return newUser;
    } catch (error) {
      console.error('Error adding user:', error);
      throw error;
    }
  }

  async getAllUsers() {
    try {
      // Ambil semua username dari index
      const usernames = await this.redis.smembers(this.userIndexKey);
      
      if (!usernames || usernames.length === 0) {
        return [];
      }

      // Ambil data setiap user secara paralel
      const userKeys = usernames.map(username => this.getUserKey(username));
      const usersData = await this.redis.mget(...userKeys);

      // Parse hasil JSON dan filter null jika ada data yang terhapus manual
      return usersData
        .filter(data => data !== null)
        .map(data => (typeof data === 'string' ? JSON.parse(data) : data));
    } catch (error) {
      console.error('Error getting users:', error);
      throw error;
    }
  }

  async getUserByUsername(username) {
    try {
      const userKey = this.getUserKey(username);
      const data = await this.redis.get(userKey);
      
      if (!data) return null;
      return typeof data === 'string' ? JSON.parse(data) : data;
    } catch (error) {
      console.error('Error getting user:', error);
      throw error;
    }
  }

  async approveUser(username, adminName) {
    try {
      const user = await this.getUserByUsername(username);
      if (!user) {
        throw new Error('User not found');
      }

      user.status = 'approved';
      user.approvedAt = new Date().toISOString();
      user.approvedBy = adminName;

      // Update data di Redis
      await this.redis.set(this.getUserKey(username), JSON.stringify(user));
      return user;
    } catch (error) {
      console.error('Error approving user:', error);
      throw error;
    }
  }

  async rejectUser(username, adminName) {
    try {
      const user = await this.getUserByUsername(username);
      if (!user) {
        throw new Error('User not found');
      }

      user.status = 'rejected';
      user.approvedAt = new Date().toISOString();
      user.approvedBy = adminName;

      // Update data di Redis
      await this.redis.set(this.getUserKey(username), JSON.stringify(user));
      return user;
    } catch (error) {
      console.error('Error rejecting user:', error);
      throw error;
    }
  }

  async deleteUser(username) {
    try {
      const userKey = this.getUserKey(username);
      const user = await this.redis.get(userKey);
      
      if (!user) {
        throw new Error('User not found');
      }

      // Hapus key user dan hapus dari index set
      await this.redis.del(userKey);
      await this.redis.srem(this.userIndexKey, username);

      return true;
    } catch (error) {
      console.error('Error deleting user:', error);
      throw error;
    }
  }
}

module.exports = new StorageConfig();
