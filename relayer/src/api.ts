import express from 'express';
import { config } from './config';
import { getEvents, getEventByNonce, getPendingEvents, db } from './db';
import { isPaused, setPaused } from './processor';

const router = express.Router();

function auth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (token !== config.adminToken) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', paused: isPaused() });
});

router.get('/status', (_req, res) => {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status='processed' THEN 1 ELSE 0 END) as processed,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed
    FROM processed_events
  `).get() as any;
  res.json({ paused: isPaused(), stats });
});

router.get('/events', (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), 1000);
  res.json(getEvents(limit));
});

router.get('/events/:nonce', (req, res) => {
  const ev = getEventByNonce(Number(req.params.nonce));
  if (!ev) return res.status(404).json({ error: 'Not found' });
  res.json(ev);
});

router.post('/admin/pause', auth, (_req, res) => {
  setPaused(true);
  res.json({ paused: true });
});

router.post('/admin/unpause', auth, (_req, res) => {
  setPaused(false);
  res.json({ paused: false });
});

export default router;
