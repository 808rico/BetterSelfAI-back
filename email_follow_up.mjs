import 'dotenv/config';
import db from './db.mjs'; // Votre configuration DB
import OpenAI from 'openai';
import fetch from 'node-fetch';
import mixpanel from 'mixpanel';

const mixpanelClient = mixpanel.init(process.env.MIXPANEL_PROJECT_TOKEN);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

(async () => {
  console.log("Cron job démarré : récupération des utilisateurs et génération d'emails.");

  try {
    const batchSize = 500; // Taille des batchs
    let offset = 0;
    let clerkUsers = [];
    let batchUsers;

    // Étape 1 : Récupérer tous les utilisateurs de Clerk par batch
    do {
      const clerkResponse = await fetch(
        `https://api.clerk.dev/v1/users?limit=${batchSize}&offset=${offset}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (!clerkResponse.ok) {
        throw new Error(`Erreur API Clerk : ${await clerkResponse.text()}`);
      }

      batchUsers = await clerkResponse.json();
      clerkUsers = [...clerkUsers, ...batchUsers];
      offset += batchSize;
    } while (batchUsers.length === batchSize);

    console.log(`Total utilisateurs récupérés de Clerk : ${clerkUsers.length}`);

    // Étape 2 : Récupérer les `conversation_hash` où le dernier message est entre 24 et 48 heures
    const currentTime = Date.now();
    const twentyFourHoursAgo = new Date(currentTime - 24 * 60 * 60 * 1000);
    const fortyEightHoursAgo = new Date(currentTime - 48 * 60 * 60 * 1000);

    const conversationsQuery = `
      SELECT conversation_hash
      FROM (
        SELECT conversation_hash, created_at
        FROM messages
        WHERE created_at BETWEEN ? AND ?
        AND sender = 'user'
      ) AS subquery
      GROUP BY conversation_hash
      ORDER BY MAX(created_at) DESC;
    `;

    const conversationHashes = await new Promise((resolve, reject) => {
      db.query(
        conversationsQuery,
        [fortyEightHoursAgo, twentyFourHoursAgo],
        (err, results) => {
          if (err) {
            console.error("Erreur lors de la récupération des conversations :", err);
            reject(err);
          } else {
            resolve(results.map((row) => row.conversation_hash));
          }
        }
      );
    });

    console.log(`Conversations sélectionnées : ${conversationHashes.length}`);

    // Étape 3 : Récupérer les `user_hash` associés à ces conversations
    let userHashes = [];

    if (conversationHashes.length > 0) {
      const userHashQuery = `
        SELECT DISTINCT user_hash
        FROM conversations
        WHERE conversation_hash IN (?)
      `;

      userHashes = await new Promise((resolve, reject) => {
        db.query(userHashQuery, [conversationHashes], (err, results) => {
          if (err) {
            console.error("Erreur lors de la récupération des user_hash :", err);
            reject(err);
          } else {
            resolve(results.map((row) => row.user_hash));
          }
        });
      });

      console.log(`Utilisateurs potentiels à notifier : ${userHashes.length}`);
    } else {
      console.log("Aucun conversation_hash trouvé. Aucune action nécessaire.");
    }

    // Étape 4 : Filtrer les utilisateurs qui existent dans Clerk
    const usersToNotify = clerkUsers.filter((user) =>
      userHashes.includes(user.id)
    );

    console.log(`Utilisateurs avec compte Clerk à notifier : ${usersToNotify.length}`);

    // Étape 5 : Envoyer les e-mails personnalisés aux utilisateurs
    for (const user of usersToNotify) {
      const email = user.email_addresses[0].email_address;
      const userId = user.id;

      console.log(`Préparation de l'email pour ${email}`);

      // Récupérer le conversation_hash et les messages associés
      const conversationQuery = `
          SELECT conversation_hash, sender, message
          FROM messages
          WHERE conversation_hash = (
            SELECT conversation_hash
            FROM conversations
            WHERE user_hash = ?
            ORDER BY created_at DESC LIMIT 1
          )
          ORDER BY created_at ASC;
        `;

      const conversationData = await new Promise((resolve, reject) => {
        db.query(conversationQuery, [userId], (err, results) => {
          if (err) {
            console.error(`Erreur lors de la récupération des messages pour user_hash=${userId} :`, err);
            reject(err);
          } else {
            resolve(results);
          }
        });
      });

      if (!conversationData.length) {
        console.log(`Aucun message trouvé pour l'utilisateur ${userId}`);
        continue;
      }

      // Récupérer le conversation_hash pour cet utilisateur
      const conversationHash = conversationData[0].conversation_hash;

      // Construire le contexte pour OpenAI
      let conversationContext = `Here is the conversation you had yesterday :\n`;
      conversationData.forEach((msg) => {
        const senderLabel = msg.sender === 'user' ? 'User' : 'Therapist';
        conversationContext += `${senderLabel} : ${msg.message}\n`;
      });

      // Generate the email subject and content with OpenAI
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        response_format: { "type": "json_object" },
        messages: [
          {
            role: "system",
            content: `
        You are a helpful assistant acting as a therapist's assistant. Your task is to draft a follow-up email after a conversation between the therapist and the patient.

        Respond strictly in the following JSON format:

        {
          "subject": "A short subject line (max 8 words)",
          "content": "A short and friendly email body personalized to the conversation context, engaging, and ending with no more than one question."
        }

        The subject should be concise and can be related to the context of the conversation. (ex: Just checking in with you...)

        The content should be a friendly, short, and engaging email body that feels personalized based on the context of the conversation. You can add some line break if needed.

        Respond ONLY in JSON format. Do not include any additional text.
      `,
          },
          { role: "user", content: conversationContext },
        ],
      });

      const responseJson = JSON.parse(completion.choices[0].message.content);

      // Extract the subject and content from the JSON response
      const emailSubject = responseJson.subject;
      const emailContent = responseJson.content;

      // Add a button and an unsubscribe link to the email content
      const emailHtmlContent = `
        <p>${emailContent.replace(/\n/g, '<br>')}</p>
        <div style="text-align: center; margin: 20px 0;">
         <a href="${process.env.URL}/talk?from_follow_up_email=true&user_id=${userId}" 
            style="display: inline-block; padding: 10px 20px; background-color: #007BFF; color: white; text-decoration: none; border-radius: 5px; font-weight: bold;">
            Reply
          </a>
        </div>
        <p style="text-align: center; margin-top: 20px;">
          <a href="${process.env.URL}/opt-out?userId=${userId}" style="color: #007BFF; text-decoration: none;">
            Unsubscribe from emails
          </a>
        </p>
      `;

      // Send the email using Brevo
      const brevoResponse = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': process.env.BREVO_API_KEY,
        },
        body: JSON.stringify({
          sender: { name: "Better Self AI", email: "hello@betterselfai.com" },
          to: [{ email }],
          subject: emailSubject,
          htmlContent: emailHtmlContent,
        }),
      });

      if (!brevoResponse.ok) {
        console.error(`Erreur lors de l'envoi de l'email à ${email} :`, await brevoResponse.text());
      } else {
        console.log(`Email envoyé avec succès à ${email}`);
        mixpanelClient.track('FOLLOW_UP_EMAIL_SENT', {
          $user_id: userId,
        });

        // Insert the generated email content into the database
        const insertMessageQuery = `
      INSERT INTO messages (conversation_hash, sender, message, message_type)
      VALUES (?, 'AI', ?, 'text_follow_up')
    `;

        await new Promise((resolve, reject) => {
          db.query(insertMessageQuery, [conversationHash, emailContent], (err, results) => {
            if (err) {
              console.error(`Erreur lors de l'insertion du message pour user_hash=${userId} :`, err);
              reject(err);
            } else {
              resolve(results);
            }
          });
        });

        console.log(`Message ajouté à la base de données pour conversation_hash=${conversationHash}`);
      }

    }

  } catch (error) {
    console.error("Erreur dans le cron job :", error);
  }

  console.log("Cron job terminé.");
})();
