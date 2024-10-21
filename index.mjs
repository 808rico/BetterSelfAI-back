// index.mjs
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import db from './db.mjs';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import fs from "fs";
import multer from 'multer';
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import https from 'https';
import { createClient } from "@deepgram/sdk";

const deepgram = createClient(process.env.DEEPGRAM_API_KEY);


const convertToWav = (inputFile, outputFile) => {
  return new Promise((resolve, reject) => {
    ffmpeg(inputFile)
      .toFormat('wav')
      .save(outputFile)
      .on('end', () => resolve(outputFile))
      .on('error', reject);
  });
};

import adminRouter from './admin.mjs';

const app = express();


const therapistVoicesMap = {
  woman1: 'alloy',
  woman2: 'fable',
  woman3: 'nova',
  woman4: 'shimmer',
  man1: 'echo',
  man2: 'onyx',
};


// Configure CORS to allow your frontend URL
const corsOptions = {
  origin: true, // Autorise toutes les origines
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']

};



app.use(cors(corsOptions));
app.use(express.json());
app.use('/admin', adminRouter);

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







// Configuration de multer pour stocker les fichiers temporairement
const upload = multer({ dest: 'uploads/' });

app.post('/api/conversations/message', upload.single('message'), async (req, res) => {
  const { userHash, conversationHash, modelId, type } = req.body;

  if (!userHash || !conversationHash || !modelId || !type) {
    return res.status(400).json({ error: 'userHash, conversationHash, modelId, and type are required' });
  }

  let messageText = null;

  try {
    // 1. Vérifier si le message est du texte ou un fichier audio
    if (type === 'text') {
      messageText = req.body.message;
    } else if (type === 'audio') {
      const audioFile = req.file;
      if (!audioFile) {
        return res.status(400).json({ error: 'Audio file is required' });
      }

      const finalFilePath = path.join('uploads', `${uuidv4()}.wav`);

      if (audioFile.mimetype !== 'audio/wav') {
        await convertToWav(audioFile.path, finalFilePath);
      } else {
        fs.renameSync(audioFile.path, finalFilePath);
      }

      // Utilisation de Deepgram pour la transcription avec la méthode `transcribeFile`
      const audioBuffer = fs.readFileSync(finalFilePath);

      const { result, error } = await deepgram.listen.prerecorded.transcribeFile(audioBuffer, {
        model: "nova-2",  // Utilisez le modèle approprié pour votre cas
      });

      if (error) {
        console.error('Error transcribing audio:', error);
        return res.status(500).json({ error: 'An error occurred while transcribing the audio' });
      }

      console.log(result.results.channels[0].alternatives[0])

      // Extraction de la transcription du résultat
      messageText = result.results.channels[0].alternatives[0].transcript;


      console.log('Transcription:', messageText);
    } else {
      return res.status(400).json({ error: 'Invalid message type' });
    }

    // 2. Récupérer les 10 derniers messages de la conversation
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

    // Compter le nombre de messages de l'utilisateur dans la conversation
    const userMessagesCountQuery = `
      SELECT COUNT(*) AS userMessageCount FROM messages 
      WHERE conversation_hash = ? AND sender = 'user'
    `;
    

    const userMessageCountResult = await new Promise((resolve, reject) => {
      db.query(userMessagesCountQuery, [conversationHash], (err, results) => {
        if (err) {
          console.error('Error fetching user message count:', err);
          reject(new Error('An error occurred while fetching user message count'));
        } else {
          resolve(results[0].userMessageCount);
        }
      });
    });

    console.log(userMessageCountResult)

    // 3. Construire le prompt de l'IA
    let conversationContext = 'Just answer the message you would say to the user without "". \n \n This is the conversation history between you (the AI) and the user:\n';
    lastMessages.reverse().forEach((msg) => {
      const senderLabel = msg.sender === 'user' ? 'User' : 'You';
      conversationContext += `${senderLabel}: ${msg.message}\n`;
    });

    // Ajouter le message actuel de l'utilisateur
    conversationContext += `User: ${messageText}\n`;

    // 4. Enregistrer le message de l'utilisateur dans la base de données avant de traiter la réponse de l'IA
    const userMessageQuery = 'INSERT INTO messages (conversation_hash, user_hash, sender, message) VALUES (?, ?, ?, ?)';
    await new Promise((resolve, reject) => {
      db.query(userMessageQuery, [conversationHash, userHash, 'user', messageText], (err) => {
        if (err) {
          console.error('Error storing user message:', err);
          reject(new Error('An error occurred while storing the user message'));
        } else {
          resolve();
        }
      });
    });

    // 5. Déterminer le prompt en fonction du nombre de messages
    let aiPrompt;
    if (userMessageCountResult === 10) {
      aiPrompt = 'You are a therapist who provides helpful answer to a patient. For this message, ask for their email politely, explaining that it’s to follow up with them. Your message should be mainly about the email. Keep it really short and engaging.';
    
    } else {
      aiPrompt = 'You are a therapist who provides helpful answer to a patient. Depending on the circumstances, you can ask open-ended questions, encourage, reframe the thought, provide empathetic/validation answers, or suggest solutions. Keep it short and engaging.';
    }

    // 6. Appeler OpenAI API pour obtenir la réponse
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: 'system', content: aiPrompt },
        { role: 'user', content: conversationContext },
      ],
    });

    const aiReply = completion.choices[0].message.content;

    // 7. Enregistrer la réponse de l'IA dans la base de données
    const aiMessageQuery = 'INSERT INTO messages (conversation_hash, user_hash, sender, message) VALUES (?, ?, ?, ?)';
    await new Promise((resolve, reject) => {
      db.query(aiMessageQuery, [conversationHash, userHash, 'AI', aiReply], (err) => {
        if (err) {
          console.error('Error storing AI message:', err);
          reject(new Error('An error occurred while storing the AI message'));
        } else {
          resolve();
        }
      });
    });

    // 8. Appeler l'API OpenAI TTS pour convertir la réponse de l'IA en audio
    try {
      const mp3 = await openai.audio.speech.create({
        model: "tts-1-hd",
        voice: modelId,
        input: aiReply,
      });

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






// Route pour démarrer une nouvelle conversation avec un message de bienvenue
app.post('/api/conversations/new-conversation', async (req, res) => {
  const { userHash } = req.body;

  if (!userHash) {
    return res.status(400).json({ error: 'userHash is required' });
  }

  try {
    // 1. Récupérer le nom et le voiceId de l'utilisateur à partir de la table 'users'
    const getUserQuery = 'SELECT name, voice as voiceId FROM users WHERE user_hash = ?';
    const userResult = await new Promise((resolve, reject) => {
      db.query(getUserQuery, [userHash], (err, results) => {
        if (err) {
          console.error('Error fetching user data:', err);
          reject(new Error('An error occurred while fetching user data'));
        } else if (results.length === 0) {
          reject(new Error('User not found'));
        } else {
          resolve(results[0]);
        }
      });
    });

    const { name: userName, voiceId } = userResult;

    // 2. Trouver le modelId correspondant via la correspondance
    const modelId = therapistVoicesMap[voiceId];
    if (!modelId) {
      throw new Error('ModelId not found for the given voiceId');
    }

    // 3. Générer un hash de conversation unique
    const conversationHash = uuidv4();
    
    // 4. Insérer une nouvelle conversation dans la base de données
    const insertConversationQuery = 'INSERT INTO conversations (conversation_hash, user_hash) VALUES (?, ?)';
    await new Promise((resolve, reject) => {
      db.query(insertConversationQuery, [conversationHash, userHash], (err) => {
        if (err) {
          console.error('Error creating conversation:', err);
          reject(new Error('An error occurred while creating the conversation'));
        } else {
          resolve();
        }
      });
    });

    // 5. Construire le message de bienvenue personnalisé
    const welcomeMessage = `Hey ${userName}, what's on your mind today?`;

    // 6. Appeler l'API OpenAI TTS pour générer l'audio du message de bienvenue avec le bon modelId
    const mp3 = await openai.audio.speech.create({
      model: "tts-1-hd", // Modèle utilisé pour la conversion texte-voix
      voice: modelId, // ModelId correct récupéré via la correspondance
      input: welcomeMessage, // Message de bienvenue
    });

    // Convertir l'ArrayBuffer en base64
    const buffer = Buffer.from(await mp3.arrayBuffer());
    const audioBase64 = buffer.toString('base64');
    const audioUrl = `data:audio/mp3;base64,${audioBase64}`;

    // 7. Stocker le message de bienvenue dans la table "messages"
    const insertMessageQuery = 'INSERT INTO messages (conversation_hash, user_hash, sender, message) VALUES (?, ?, ?, ?)';
    await new Promise((resolve, reject) => {
      db.query(insertMessageQuery, [conversationHash, userHash, 'AI', welcomeMessage], (err) => {
        if (err) {
          console.error('Error storing welcome message:', err);
          reject(new Error('An error occurred while storing the welcome message'));
        } else {
          resolve();
        }
      });
    });

    // 8. Retourner le hash de conversation, le message de bienvenue et l'audio
    res.status(201).json({
      message: 'Conversation created successfully',
      conversationHash,
      welcomeMessage,
      audio: audioUrl
    });

  } catch (error) {
    console.error('Error creating new conversation:', error);
    res.status(500).json({ error: 'An error occurred while creating the new conversation' });
  }
});



const PORT = process.env.PORT || 5001;

// Si USE_HTTPS est défini et que l'environnement est de développement
if (process.env.USE_HTTPS === 'true') {
  // Charger les certificats SSL
  const options = {
    key: fs.readFileSync(path.resolve('certs/privatekey.pem')),
    cert: fs.readFileSync(path.resolve('certs/certificate.pem'))
  };

  // Lancer le serveur HTTPS
  https.createServer(options, app).listen(PORT, '0.0.0.0', () => {
    console.log(`Server running with HTTPS on port ${PORT}`);
  });
} else {
  // Lancer le serveur HTTP classique
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
}

