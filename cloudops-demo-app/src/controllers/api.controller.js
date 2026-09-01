/**
 * In-memory sample data for Phase 1 testing workload
 */
const USERS = [
  { id: 1, name: 'Alice', role: 'user' },
  { id: 2, name: 'Bob', role: 'admin' },
  { id: 3, name: 'Charlie', role: 'user' }
];

const PRODUCTS = [
  { id: 1, name: 'Cloud Storage Standard', category: 'storage', price: 9.99 },
  { id: 2, name: 'Compute Instance Basic', category: 'compute', price: 24.50 },
  { id: 3, name: 'Managed Database Micro', category: 'database', price: 15.00 },
  { id: 4, name: 'Global CDN Accelerator', category: 'networking', price: 12.00 }
];

/**
 * Root endpoint controller
 */
const getRoot = (req, res) => {
  res.status(200).json({
    name: 'cloudops-demo-app',
    message: 'CloudOps Demo Application is running',
    version: '1.0.0'
  });
};

/**
 * Application metadata endpoint
 */
const getInfo = (req, res) => {
  res.status(200).json({
    application: 'cloudops-demo-app',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development'
  });
};

/**
 * List all users
 */
const getUsers = (req, res) => {
  res.status(200).json(USERS);
};

/**
 * Get user by ID
 */
const getUserById = (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(404).json({
      error: 'User not found',
      message: `Invalid user ID '${req.params.id}'`
    });
  }

  const user = USERS.find((u) => u.id === id);
  if (!user) {
    return res.status(404).json({
      error: 'User not found',
      message: `User with ID ${id} was not found`
    });
  }

  return res.status(200).json(user);
};

/**
 * List all products
 */
const getProducts = (req, res) => {
  res.status(200).json(PRODUCTS);
};

module.exports = {
  getRoot,
  getInfo,
  getUsers,
  getUserById,
  getProducts
};
