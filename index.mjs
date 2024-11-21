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
import { clerkMiddleware, getAuth, requireAuth } from '@clerk/express';
import adminRouter from './admin.mjs';
import billingRoutes from './billing.mjs';

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
  methods: ['GET', 'POST', 'PUT', 'DELETE']

};


app.use(clerkMiddleware());
app.use(cors(corsOptions));


app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));
// Middleware JSON pour toutes les autres routes
app.use(express.json());

app.use('/admin', adminRouter);
app.use('/api/billing', billingRoutes);


// Initialiser OpenAI avec la clé d'API
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});



// Route pour récupérer les informations de l'utilisateur via userHash
// Route pour récupérer les informations de l'utilisateur et les 100 derniers messages de la première conversation
app.get('/api/users/:userHash', (req, res) => {
  const { userHash } = req.params;

  // Récupérer les informations de l'utilisateur
  const userQuery = 'SELECT * FROM users WHERE user_hash = ?';
  db.query(userQuery, [userHash], (userErr, userResults) => {
    if (userErr) {
      console.error('Error fetching user data:', userErr);
      return res.status(500).json({ error: 'An error occurred while fetching user data' });
    }

    if (userResults.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userInfo = userResults[0];

    // Récupérer la première conversation de l'utilisateur
    const conversationQuery = 'SELECT conversation_hash FROM conversations WHERE user_hash = ? ORDER BY created_at ASC LIMIT 1';
    db.query(conversationQuery, [userHash], (convErr, convResults) => {
      if (convErr) {
        console.error('Error fetching conversation data:', convErr);
        return res.status(500).json({ error: 'An error occurred while fetching conversation data' });
      }

      if (convResults.length === 0) {
        return res.status(404).json({ error: 'No conversation found for this user' });
      }

      const conversationHash = convResults[0].conversation_hash;

      // Récupérer les 100 derniers messages de la première conversation
      const messagesQuery = `
        SELECT sender, message, created_at FROM messages 
        WHERE conversation_hash = ? 
        ORDER BY created_at DESC 
        LIMIT 100
      `;
      db.query(messagesQuery, [conversationHash], (msgErr, msgResults) => {
        if (msgErr) {
          console.error('Error fetching messages:', msgErr);
          return res.status(500).json({ error: 'An error occurred while fetching messages' });
        }

        // Ajouter type: 'text' et renommer message en content pour chaque message
        const messages = msgResults.map(msg => ({
          sender: msg.sender,
          content: msg.message,  // Renommer 'message' en 'content'
          created_at: msg.created_at,
          type: 'text'  // Ajouter type 'text' pour chaque message
        })).reverse(); // Inverser l'ordre pour afficher du plus ancien au plus récent

        res.status(200).json({ userInfo, messages });
      });
    });
  });
});


app.get('/api/users/check-user/:userId', (req, res) => {
  const { userId } = req.params;

  // Vérifier si l'utilisateur existe dans la base de données et récupérer les colonnes name, photo, et voice
  const query = 'SELECT name, photo, voice FROM users WHERE user_hash = ?';
  db.query(query, [userId], (err, results) => {
    if (err) {
      console.error('Erreur lors de la récupération des données utilisateur :', err);
      return res.status(500).json({ error: 'Une erreur est survenue lors de la vérification de l\'utilisateur' });
    }

    // Vérifier si des résultats ont été trouvés
    if (results.length > 0) {
      const user = results[0];
      return res.status(200).json({
        exists: true,
        name: user.name,
        photo: user.photo,
        voice: user.voice
      });
    } else {
      return res.status(200).json({ exists: false });
    }
  });
});



app.post('/api/users/switch-user-hash', requireAuth(), (req, res) => {
  // Récupérer l'userID authentifié depuis Clerk
  const userID = req.auth.userId;
  const { oldUserHash } = req.body; // On reçoit l'ancien userHash depuis le corps de la requête
  console.log('skurt');
  console.log(userID);

  // Vérifier que oldUserHash est fourni
  if (!oldUserHash) {
    return res.status(400).json({ error: 'Old userHash is required' });
  }

  // Vérifier si l'userID est déjà présent dans la table users
  const checkUserExistsQuery = 'SELECT 1 FROM users WHERE user_hash = ? LIMIT 1';
  db.query(checkUserExistsQuery, [userID], (checkErr, checkResult) => {
    if (checkErr) {
      console.error('Error checking user existence:', checkErr);
      return res.status(500).json({ error: 'An error occurred while checking user existence' });
    }

    // Si l'userID est déjà présent, ne rien faire et renvoyer 200
    if (checkResult.length > 0) {
      return res.status(200).json({ message: 'UserID already present, no update needed' });
    }

    // Mettre à jour le user_hash dans les tables si l'userID n'est pas trouvé
    const updateUserHashQuery = 'UPDATE users SET user_hash = ? WHERE user_hash = ?';
    db.query(updateUserHashQuery, [userID, oldUserHash], (userErr, userResult) => {
      if (userErr) {
        console.error('Error updating user data:', userErr);
        return res.status(500).json({ error: 'An error occurred while updating user data' });
      }

      const updateConversationsQuery = 'UPDATE conversations SET user_hash = ? WHERE user_hash = ?';
      db.query(updateConversationsQuery, [userID, oldUserHash], (convErr, convResult) => {
        if (convErr) {
          console.error('Error updating conversation data:', convErr);
          return res.status(500).json({ error: 'An error occurred while updating conversation data' });
        }

        res.status(200).json({
          message: 'User hash updated successfully across users, conversations, and messages tables'
        });

      });
    });
  });
});






// Configuration de multer pour stocker les fichiers temporairement
const upload = multer({ dest: 'uploads/' });
app.post('/api/conversations/message', upload.single('message'), async (req, res) => {
  const { userHash, modelId, type } = req.body;

  if (!userHash || !modelId || !type) {
    return res.status(400).json({ error: 'userHash, modelId, and type are required' });
  }

  const auth = getAuth(req);
  if (auth.userId) {
    console.log(`User is authenticated with userId: ${auth.userId}`);
  } else {
    console.log('User is not authenticated');
  }

  let messageText = null;
  let conversationHash = null;

  try {
    // 1. Récupérer le conversationHash pour cet utilisateur
    const getConversationHashQuery = `
      SELECT conversation_hash FROM conversations WHERE user_hash = ? ORDER BY created_at DESC LIMIT 1
    `;
    conversationHash = await new Promise((resolve, reject) => {
      db.query(getConversationHashQuery, [userHash], (err, results) => {
        if (err) {
          console.error('Error fetching conversationHash:', err);
          reject(new Error('An error occurred while fetching conversationHash'));
        } else if (results.length === 0) {
          reject(new Error('No active conversation found for this user'));
        } else {
          resolve(results[0].conversation_hash);
        }
      });
    });

    // 2. Vérifier si le message est du texte ou un fichier audio
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

      const audioBuffer = fs.readFileSync(finalFilePath);

      const { result, error } = await deepgram.listen.prerecorded.transcribeFile(audioBuffer, {
        model: "nova-2",
      });

      if (error) {
        console.error('Error transcribing audio:', error);
        return res.status(500).json({ error: 'An error occurred while transcribing the audio' });
      }

      messageText = result.results.channels[0].alternatives[0].transcript;
      console.log('Transcription:', messageText);
    } else {
      return res.status(400).json({ error: 'Invalid message type' });
    }

    // 3. Insérer le message de l'utilisateur avec le timestamp actuel
    const userMessageQuery = 'INSERT INTO messages (conversation_hash, sender, message, message_type, created_at) VALUES (?, ?, ?, ?, ?)';
    const currentTimestamp = new Date(); // Timestamp actuel
    await new Promise((resolve, reject) => {
      db.query(userMessageQuery, [conversationHash, 'user', messageText, type, currentTimestamp], (err) => {
        if (err) {
          console.error('Error storing user message:', err);
          reject(new Error('An error occurred while storing the user message'));
        } else {
          resolve();
        }
      });
    });


    const getSubscriptionQuery = `
  SELECT MAX(end_date) AS latest_end_date 
  FROM subscriptions 
  WHERE user_hash = ?
`;
    //Check si l'utilisateur est abonné
    const subscriptionStatus = await new Promise((resolve, reject) => {
      db.query(getSubscriptionQuery, [auth.userId], (err, results) => {
        if (err) {
          console.error('Error fetching subscription status:', err);
          reject(new Error('An error occurred while fetching subscription status'));
        } else {
          if (results.length > 0 && results[0].latest_end_date && new Date(results[0].latest_end_date) > new Date()) {
            resolve(true); // L'utilisateur est abonné
          } else {
            resolve(false); // L'utilisateur n'est pas abonné ou l'abonnement est expiré
          }
        }
      });
    });

    // 4. Compter le nombre de message total
    const getTotalMessageCountQuery = `
      SELECT count(Distinct(id)) FROM messages
      WHERE conversation_hash = ? AND sender = 'user'
    `;
    let totalMessageCount = await new Promise((resolve, reject) => {
      db.query(getTotalMessageCountQuery, [conversationHash], (err, results) => {
        if (err) {
          console.error('Error fetching last messages:', err);
          reject(new Error('An error occurred while fetching last messages'));
        } else {
          resolve(results);
        }
      });
    });
    totalMessageCount = totalMessageCount[0]['count(Distinct(id))']

    console.log('Total', totalMessageCount)





    // 4. Créer le contexte pour l'IA
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

    let conversationContext = 'Just answer the message you would say to the user without "". \n \n This is the conversation history between you (the AI) and the user:\n';
    lastMessages.reverse().forEach((msg) => {
      const senderLabel = msg.sender === 'user' ? 'User' : 'You';
      conversationContext += `${senderLabel}: ${msg.message}\n`;
    });

    conversationContext += `User: ${messageText}\n`;

    let aiReply;
    const userMessagesCount = lastMessages.filter(msg => msg.sender === 'user').length;

    let aiPrompt;



    if (!auth.userId && userMessagesCount >= 8) {
      // L'utilisateur n'est pas connecté et a atteint la limite de 8 messages

      aiPrompt = 'You are a therapist. Your goal is to make people login to the service to keep chatting with you. You can not answer to the user query, your goal is to make the user to login. Once the user will be logged in he will be able to keep talking to you. The login button is at the top right corner of the screen. Keep it short and engaging.';
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: 'system', content: aiPrompt },
          { role: 'user', content: conversationContext },
        ],
      });

      aiReply = completion.choices[0].message.content;
    } else if (auth.userId && !subscriptionStatus && totalMessageCount >= 15) {
      // L'utilisateur est connecté mais non abonné, a atteint la limite de 15 messages
      aiReply = 'You’ve reached your message limit. Please subscribe to continue the conversation and receive the support you deserve.';
    } else {
      // L'utilisateur est soit connecté et abonné, soit sous la limite des messages
      aiPrompt = 'You are a therapist who provides helpful answers to a patient. Depending on the circumstances, you can ask open-ended questions, encourage, reframe the thought, provide empathetic/validation answers, or suggest solutions. Keep it short and engaging.';
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: 'system', content: aiPrompt },
          { role: 'user', content: conversationContext },
        ],
      });

      aiReply = completion.choices[0].message.content;
    }




    // 6. Insérer le message de l'IA avec un timestamp incrémenté de 1 seconde
    const aiTimestamp = new Date(currentTimestamp.getTime() + 1000); // Ajouter 1 seconde
    const aiMessageQuery = 'INSERT INTO messages (conversation_hash, sender, message, message_type, created_at) VALUES (?, ?, ?, ?, ?)';
    await new Promise((resolve, reject) => {
      db.query(aiMessageQuery, [conversationHash, 'AI', aiReply, 'text', aiTimestamp], (err) => {
        if (err) {
          console.error('Error storing AI message:', err);
          reject(new Error('An error occurred while storing the AI message'));
        } else {
          resolve();
        }
      });
    });

    // 7. Générer l'audio de la réponse de l'IA
    try {
      const mp3 = await openai.audio.speech.create({
        model: "tts-1-hd",
        voice: modelId,
        input: aiReply,
      });

      const buffer = Buffer.from(await mp3.arrayBuffer());
      const audioBase64 = buffer.toString('base64');
      const audioUrl = `data:audio/mp3;base64,${audioBase64}`;

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






app.post('/api/new-user', async (req, res) => {
  const { name, photo, voice, userHash } = req.body;

  // Étape 1 : Vérifier si l'utilisateur existe déjà dans la base de données
  const checkUserQuery = 'SELECT * FROM users WHERE user_hash = ?';

  try {
    const userExists = await new Promise((resolve, reject) => {
      db.query(checkUserQuery, [userHash], (err, results) => {
        if (err) {
          console.error('Error checking user existence:', err);
          reject(new Error('An error occurred while checking user existence'));
        } else {
          resolve(results.length > 0);
        }
      });
    });

    if (userExists) {
      return res.status(400).json({ error: 'User already exists' });
    }

    // Étape 2 : Insérer les informations utilisateur dans la base de données
    const insertUserQuery = 'INSERT INTO users (name, photo, voice, user_hash) VALUES (?, ?, ?, ?)';
    await new Promise((resolve, reject) => {
      db.query(insertUserQuery, [name, photo, voice, userHash], (err, results) => {
        if (err) {
          console.error('Error inserting user:', err);
          reject(new Error('An error occurred while saving user data'));
        } else {
          resolve(results);
        }
      });
    });
    console.log('User data saved successfully');

    // Étape 3 : Vérifier le modelId correspondant au voice
    const modelId = therapistVoicesMap[voice];
    if (!modelId) {
      throw new Error('ModelId not found for the given voice');
    }

    // Étape 4 : Générer un hash de conversation unique
    const conversationHash = uuidv4();

    // Étape 5 : Insérer la conversation dans la base de données
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

    // Étape 6 : Construire le message de bienvenue personnalisé
    const welcomeMessage = `Hey ${name}, what's on your mind today?`;

    // Étape 7 : Générer l'audio du message de bienvenue
    const mp3 = await openai.audio.speech.create({
      model: "tts-1-hd",
      voice: modelId,
      input: welcomeMessage,
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());
    const audioBase64 = buffer.toString('base64');
    const audioUrl = `data:audio/mp3;base64,${audioBase64}`;

    // Étape 8 : Enregistrer le message de bienvenue dans la table "messages"
    const insertMessageQuery = 'INSERT INTO messages (conversation_hash, sender, message, message_type) VALUES (?,  ?, ?,?)';
    await new Promise((resolve, reject) => {
      db.query(insertMessageQuery, [conversationHash, 'AI', welcomeMessage, 'text'], (err) => {
        if (err) {
          console.error('Error storing welcome message:', err);
          reject(new Error('An error occurred while storing the welcome message'));
        } else {
          resolve();
        }
      });
    });

    // Étape 9 : Retourner le hash de conversation, le message de bienvenue et l'audio
    res.status(201).json({
      message: 'User and conversation created successfully',
      conversationHash,
      welcomeMessage,
      audio: audioUrl
    });

  } catch (error) {
    console.error('Error in new-user route:', error);
    res.status(500).json({ error: 'An error occurred while creating the user and conversation' });
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

