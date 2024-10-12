// admin.mjs
import express from 'express';
import db from './db.mjs';

const router = express.Router();


  

// Route pour obtenir toutes les conversations paginées par 100
router.get('/conversations', async (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const limit = 100;
  const offset = (page - 1) * limit;

  try {
    const query = 'SELECT conversation_hash, created_at FROM conversations ORDER BY created_at DESC LIMIT ? OFFSET ?';
    db.query(query, [limit, offset], (err, results) => {
      if (err) {
        console.error('Error fetching conversations:', err);
        return res.status(500).json({ error: 'Error fetching conversations' });
      }
      res.status(200).json(results);
    });
  } catch (error) {
    res.status(500).json({ error: 'An error occurred while fetching conversations' });
  }
});

// Route pour obtenir les détails d'une conversation et les messages (paginés par 50)
router.get('/conversations/:hash', async (req, res) => {
  const { hash } = req.params;
  const page = parseInt(req.query.page, 10) || 1;
  const limit = 150;
  const offset = (page - 1) * limit;

  try {
    // Récupérer les informations de l'utilisateur liées à la conversation
    const userQuery = `
      SELECT u.name, u.photo, u.voice 
      FROM conversations c 
      JOIN users u ON c.user_hash = u.user_hash 
      WHERE c.conversation_hash = ?
    `;
    const user = await new Promise((resolve, reject) => {
      db.query(userQuery, [hash], (err, results) => {
        if (err) {
          reject(err);
        } else if (results.length === 0) {
          reject(new Error('Conversation not found'));
        } else {
          resolve(results[0]);
        }
      });
    });

    // Récupérer les messages de la conversation paginés
    const messageQuery = `
      SELECT sender, message, created_at 
      FROM messages 
      WHERE conversation_hash = ? 
      ORDER BY created_at DESC 
      LIMIT ? OFFSET ?
    `;
    const messages = await new Promise((resolve, reject) => {
      db.query(messageQuery, [hash, limit, offset], (err, results) => {
        if (err) {
          reject(err);
        } else {
          resolve(results);
        }
      });
    });

    res.status(200).json({ user, messages });
  } catch (error) {
    res.status(500).json({ error: 'An error occurred while fetching conversation details' });
  }
});

export default router;
