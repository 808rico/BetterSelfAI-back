// index.mjs
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import db from './db.mjs';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import fs from "fs";
import path from "path";
import { ElevenLabsClient, ElevenLabs } from "elevenlabs";

// Initialiser le client Eleven Labs avec la clé API
const elevenlabs = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY // Defaults to process.env.ELEVENLABS_API_KEY
})

const app = express();

app.use(cors());
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
    // Store the user's message in the database
    const userMessageQuery = 'INSERT INTO messages (conversation_hash, user_hash, sender, message) VALUES (?, ?, ?, ?)';
    db.query(userMessageQuery, [conversationHash, userHash, 'user', message], (err) => {
      if (err) {
        console.error('Error storing user message:', err);
        return res.status(500).json({ error: 'An error occurred while storing the user message' });
      }
    });

    // Call OpenAI API to get the response
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: 'system', content: 'You are a therapist. Answer questions and provide helpful, empathetic responses.' },
        { role: 'user', content: message },
      ],
    });

    const aiReply = completion.choices[0].message.content;
    
    // Store the AI's response in the database
    const aiMessageQuery = 'INSERT INTO messages (conversation_hash, user_hash, sender, message) VALUES (?, ?, ?, ?)';
    db.query(aiMessageQuery, [conversationHash, userHash, 'AI', aiReply], (err) => {
      if (err) {
        console.error('Error storing AI message:', err);
        return res.status(500).json({ error: 'An error occurred while storing the AI message' });
      }
    });

    // Call the OpenAI TTS API to convert the AI response to audio using the provided modelId
    try {
      const mp3 = await openai.audio.speech.create({
        model: "tts-1-hd", // The model to use for text-to-speech
        voice: modelId, // The modelId sent from the frontend
        input: aiReply, // The text response from the AI
      });

      // Convert the resulting ArrayBuffer to a Buffer
      const buffer = Buffer.from(await mp3.arrayBuffer());
      const audioBase64 = buffer.toString('base64');
      const audioUrl = `data:audio/mp3;base64,${audioBase64}`;

      // Return the AI response text and the audio URL
      res.status(200).json({ reply: aiReply, audio: audioUrl });
    } catch (openaiTtsError) {
      console.error('Error with OpenAI TTS API:', openaiTtsError);
      return res.status(500).json({ error: 'An error occurred while generating the audio with OpenAI' });
    }

  } catch (error) {
    console.error('Error fetching response from OpenAI:', error);
    res.status(500).json({ error: 'An error occurred while communicating with the AI' });
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
