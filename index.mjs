// index.mjs
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import db from './db.mjs';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';



const app = express();

// Configure CORS to allow your frontend URL
const corsOptions = {
  origin: ['https://betterselfai.com', 'https://betterselfai.netlify.app', 'http://localhost:3000', 'http://localhost:5173',], // Add other URLs if needed
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
app.use(express.json());

// Initialiser OpenAI avec la clé d'API
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Route pour recevoir les données de l'utilisateur
app.post('/api/users', (req, res) => {
  const { name, photo, voice, userHash } = req.body;

  const query = 'INSERT INTO users (name, photo, voice, user_hash) VALUES (?, ?, ?, ?)';
  db.query(query, [name, photo, voice, userHash], (err, results) => {
    if (err) {
      console.error('Error inserting user:', err);
      return res.status(500).json({ error: 'An error occurred while saving user data' });
    }
    res.status(201).json({ message: 'User data saved successfully', data: results });
  });
});

// Route pour récupérer les informations de l'utilisateur via userHash
app.get('/api/users/:userHash', (req, res) => {
  const { userHash } = req.params;

  const query = 'SELECT * FROM users WHERE user_hash = ?';
  db.query(query, [userHash], (err, results) => {
    if (err) {
      console.error('Error fetching user data:', err);
      return res.status(500).json({ error: 'An error occurred while fetching user data' });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.status(200).json(results[0]);
  });
});


app.post('/api/conversations/message', async (req, res) => {
  const { userHash, message, conversationHash, modelId } = req.body;

  if (!userHash || !message || !conversationHash || !modelId) {
    return res.status(400).json({ error: 'userHash, message, conversationHash, and modelId are required' });
  }

  try {
    // 1. Récupérer les 5 derniers messages de la conversation
    const getLastMessagesQuery = `
      SELECT sender, message FROM messages 
      WHERE conversation_hash = ? 
      ORDER BY created_at DESC 
      LIMIT 20
    `;
    
    const lastMessages = await new Promise((resolve, reject) => {
      db.query(getLastMessagesQuery, [conversationHash], (err, results) => {
        if (err) {
          console.error('Error fetching last messages:', err);
          reject(new Error('An error occurred while fetching last messages'));
        } else {
          resolve(results);
        }
      });
    });

    // 2. Construire le prompt en texte avec les messages récents
    let conversationContext = 'Just answer the message you would say to the user without "" . \n \n This is the conversation history between you (the AI) and the user:\n';
    lastMessages.reverse().forEach((msg) => {
      const senderLabel = msg.sender === 'user' ? 'User' : 'You';
      conversationContext += `${senderLabel}: ${msg.message}\n`;
    });

    // Ajouter le message actuel de l'utilisateur
    conversationContext += `User: ${message}\n`;

    // 3. Appeler OpenAI API pour obtenir la réponse en fournissant tout le contexte sous forme de texte
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: 'system', content: 'You are a therapist. Answer questions and provide helpful, empathetic responses.' },
        { role: 'user', content: conversationContext },
      ],
    });


    const aiReply = completion.choices[0].message.content;

    // 4. Enregistrer le message de l'utilisateur dans la base de données
    const userMessageQuery = 'INSERT INTO messages (conversation_hash, user_hash, sender, message) VALUES (?, ?, ?, ?)';
    db.query(userMessageQuery, [conversationHash, userHash, 'user', message], (err) => {
      if (err) {
        console.error('Error storing user message:', err);
        return res.status(500).json({ error: 'An error occurred while storing the user message' });
      }
    });

    // 5. Enregistrer la réponse de l'IA dans la base de données
    const aiMessageQuery = 'INSERT INTO messages (conversation_hash, user_hash, sender, message) VALUES (?, ?, ?, ?)';
    db.query(aiMessageQuery, [conversationHash, userHash, 'AI', aiReply], (err) => {
      if (err) {
        console.error('Error storing AI message:', err);
        return res.status(500).json({ error: 'An error occurred while storing the AI message' });
      }
    });

    // 6. Appeler l'API OpenAI TTS pour convertir la réponse de l'IA en audio
    try {
      const mp3 = await openai.audio.speech.create({
        model: "tts-1-hd", // Modèle utilisé pour la conversion texte-voix
        voice: modelId, // ModelId envoyé par le frontend
        input: aiReply, // Réponse textuelle de l'IA
      });

      // Convertir le ArrayBuffer en base64
      const buffer = Buffer.from(await mp3.arrayBuffer());
      const audioBase64 = buffer.toString('base64');
      const audioUrl = `data:audio/mp3;base64,${audioBase64}`;

      // Retourner la réponse textuelle et l'audio
      res.status(200).json({ reply: aiReply, audio: audioUrl });
    } catch (openaiTtsError) {
      console.error('Error with OpenAI TTS API:', openaiTtsError);
      return res.status(500).json({ error: 'An error occurred while generating the audio with OpenAI' });
    }

  } catch (error) {
    console.error('Error processing conversation message:', error);
    res.status(500).json({ error: 'An error occurred while processing the conversation message' });
  }
});





// Route pour démarrer une nouvelle conversation
app.post('/api/conversations/new-conversation', (req, res) => {
  const { userHash } = req.body;

  if (!userHash) {
    return res.status(400).json({ error: 'userHash is required' });
  }

  const conversationHash = uuidv4();
  const query = 'INSERT INTO conversations (conversation_hash, user_hash) VALUES (?, ?)';

  db.query(query, [conversationHash, userHash], (err, results) => {
    if (err) {
      console.error('Error creating conversation:', err);
      return res.status(500).json({ error: 'An error occurred while creating the conversation' });
    }
    res.status(201).json({ message: 'Conversation created successfully', conversationHash });
  });
});


const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
