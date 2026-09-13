'use strict';

const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');
const { contact, validators } = require('../controllers/contactController');

const router = Router();

const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: 'Too many messages sent. Please try again later.' }),
});

router.post('/', contactLimiter, validators, contact);

module.exports = router;
