const express = require('express');
const {
  getInfo,
  getUsers,
  getUserById,
  getProducts
} = require('../controllers/api.controller');

const router = express.Router();

router.get('/info', getInfo);
router.get('/users', getUsers);
router.get('/users/:id', getUserById);
router.get('/products', getProducts);

module.exports = router;
