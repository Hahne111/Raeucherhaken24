'use strict';
const express = require('express');
const router = express.Router();
router.get('/', (req, res) => res.send('Konto folgt'));
module.exports = router;
