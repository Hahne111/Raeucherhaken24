'use strict';
const express = require('express');
const db = require('../db');
const audit = require('../lib/audit');
const util = require('../lib/util');
const router = express.Router();

function participant(threadId, userId) {
  return db.get('SELECT * FROM message_participants WHERE thread_id=? AND user_id=?', [threadId, userId]);
}

router.get('/', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  const page = Math.max(1, util.toInt(req.query.seite, 1));
  const where = q ? ' AND t.subject LIKE ?' : '';
  const params = [req.admin.id, ...(q ? [`%${q}%`] : [])];
  const total = db.get(`SELECT COUNT(*) AS c FROM message_threads t
    JOIN message_participants mp ON mp.thread_id=t.id AND mp.user_id=?${where}`, params).c;
  const rows = db.all(`SELECT t.id, t.subject, t.created_at,
      (SELECT body FROM messages WHERE thread_id=t.id ORDER BY id DESC LIMIT 1) AS preview,
      (SELECT created_at FROM messages WHERE thread_id=t.id ORDER BY id DESC LIMIT 1) AS last_at,
      (SELECT COUNT(*) FROM messages m WHERE m.thread_id=t.id AND m.id>mp.last_read_id AND m.sender_id!=?) AS unread,
      (SELECT GROUP_CONCAT(COALESCE(NULLIF(u.name,''),u.email), ', ')
       FROM message_participants other JOIN admin_users u ON u.id=other.user_id
       WHERE other.thread_id=t.id AND other.user_id!=?) AS others
    FROM message_threads t JOIN message_participants mp ON mp.thread_id=t.id AND mp.user_id=?${where}
    ORDER BY (SELECT MAX(id) FROM messages WHERE thread_id=t.id) DESC LIMIT 30 OFFSET ?`,
  [req.admin.id, req.admin.id, ...params, (page - 1) * 30]);
  res.render('admin/messages', { title: 'Nachrichten', rows, total, page,
    pages: Math.max(1, Math.ceil(total / 30)), q });
});

router.get('/neu', (req, res) => res.render('admin/message-new', {
  title: 'Neue Unterhaltung', recipients: db.all(
    'SELECT id,name,email FROM admin_users WHERE active=1 AND id!=? ORDER BY name,email', [req.admin.id]),
  error: '', input: {}
}));

router.post('/neu', (req, res) => {
  const subject = String(req.body.subject || '').trim();
  const body = String(req.body.body || '').trim();
  const raw = [].concat(req.body.recipient_ids || []);
  const ids = [...new Set(raw.map((id) => String(id).trim()))];
  const recipients = db.all('SELECT id,name,email FROM admin_users WHERE active=1 AND id!=? ORDER BY name,email', [req.admin.id]);
  const available = new Set(recipients.map((row) => String(row.id)));
  if (subject.length < 3 || subject.length > 160 || !body || body.length > 4000 || !ids.length || ids.length > 20 ||
      ids.some((id) => !/^\d+$/.test(id) || !available.has(id))) {
    return res.status(400).render('admin/message-new', {
      title: 'Neue Unterhaltung', recipients, input: req.body,
      error: 'Bitte Betreff, Nachricht und ein bis 20 aktive Empfänger auswählen.'
    });
  }
  const id = db.transaction(() => {
    const threadId = Number(db.run('INSERT INTO message_threads (subject,created_by) VALUES (?,?)',
      [subject, req.admin.id]).lastInsertRowid);
    for (const userId of [req.admin.id, ...ids.map(Number)]) {
      db.run('INSERT INTO message_participants (thread_id,user_id) VALUES (?,?)', [threadId, userId]);
    }
    const messageId = Number(db.run('INSERT INTO messages (thread_id,sender_id,body) VALUES (?,?,?)',
      [threadId, req.admin.id, body]).lastInsertRowid);
    db.run('UPDATE message_participants SET last_read_id=? WHERE thread_id=? AND user_id=?',
      [messageId, threadId, req.admin.id]);
    audit.log(req.admin.email, 'nachricht.angelegt', 'message_thread', String(threadId), subject, req.ip);
    return threadId;
  });
  req.flash('success', 'Unterhaltung angelegt.');
  res.redirect('/verwaltung/nachrichten/' + id);
});

router.get('/:id', (req, res, next) => {
  const id = util.toInt(req.params.id, 0);
  if (!participant(id, req.admin.id)) return next();
  const thread = db.get('SELECT * FROM message_threads WHERE id=?', [id]);
  if (!thread) return next();
  const members = db.all(`SELECT u.id, u.name, u.email FROM message_participants mp
    JOIN admin_users u ON u.id=mp.user_id WHERE mp.thread_id=? ORDER BY u.name,u.email`, [id]);
  const messages = db.all(`SELECT m.*, u.name AS sender_name, u.email AS sender_email FROM messages m
    JOIN admin_users u ON u.id=m.sender_id WHERE m.thread_id=? ORDER BY m.id`, [id]);
  const mark = participant(id, req.admin.id);
  res.render('admin/message-thread', { title: thread.subject, thread, members, messages,
    unread: messages.some((m) => m.id > mark.last_read_id && m.sender_id !== req.admin.id) });
});

router.post('/:id/antworten', (req, res, next) => {
  const id = util.toInt(req.params.id, 0);
  if (!participant(id, req.admin.id)) return next();
  const body = String(req.body.body || '').trim();
  if (!body || body.length > 4000) {
    req.flash('error', 'Die Nachricht muss zwischen 1 und 4000 Zeichen enthalten.');
    return res.redirect('/verwaltung/nachrichten/' + id);
  }
  db.transaction(() => {
    const messageId = Number(db.run('INSERT INTO messages (thread_id,sender_id,body) VALUES (?,?,?)',
      [id, req.admin.id, body]).lastInsertRowid);
    db.run('UPDATE message_participants SET last_read_id=? WHERE thread_id=? AND user_id=?',
      [messageId, id, req.admin.id]);
    audit.log(req.admin.email, 'nachricht.antwort', 'message_thread', String(id), `Nachricht ${messageId}`, req.ip);
  });
  req.flash('success', 'Antwort gespeichert.');
  res.redirect('/verwaltung/nachrichten/' + id);
});

router.post('/:id/gelesen', (req, res, next) => {
  const id = util.toInt(req.params.id, 0);
  const member = participant(id, req.admin.id);
  if (!member) return next();
  const newest = db.get('SELECT MAX(id) AS id FROM messages WHERE thread_id=?', [id]).id || 0;
  if (newest > member.last_read_id) {
    db.transaction(() => {
      db.run('UPDATE message_participants SET last_read_id=? WHERE thread_id=? AND user_id=?',
        [newest, id, req.admin.id]);
      audit.log(req.admin.email, 'nachricht.gelesen', 'message_thread', String(id), `bis Nachricht ${newest}`, req.ip);
    });
  }
  res.redirect('/verwaltung/nachrichten/' + id);
});

module.exports = router;
