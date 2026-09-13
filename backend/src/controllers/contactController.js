'use strict';

const { body, validationResult } = require('express-validator');
const { sendContactEmail } = require('../services/brevo');
const asyncHandler = require('../middleware/asyncHandler');

async function contact(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ error: errors.array()[0].msg });
  }

  const { firstName, lastName, email, company, subject, message } = req.body;

  await sendContactEmail({ firstName, lastName, email, company, subject, message });

  return res.json({ message: 'Message sent successfully.' });
}

module.exports = {
  contact: asyncHandler(contact),
  validators: [
    body('firstName').trim().notEmpty().withMessage('First name is required'),
    body('lastName').trim().notEmpty().withMessage('Last name is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('subject').notEmpty().withMessage('Subject is required'),
    body('message').trim().notEmpty().withMessage('Message is required'),
    body('company').optional().trim(),
  ],
};
