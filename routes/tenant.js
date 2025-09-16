const express = require('express');
const router = express.Router();
const tenantController = require('../controllers/tenant.controller');
const maybeTenant = require('../middleware/maybeTenant');

router.get('/profile', maybeTenant, tenantController.getProfile);

module.exports = router;
