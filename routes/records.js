const express = require('express');
const router = express.Router();
const recordsController = require('../controllers/records.controller');
const maybeTenant = require('../middleware/maybeTenant');

router.get('/', maybeTenant, recordsController.list);
router.post('/:id/confirm', maybeTenant, recordsController.confirm);
router.post('/:id/cancel', maybeTenant, recordsController.cancel);

module.exports = router;
