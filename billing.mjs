import express from 'express';
import Stripe from 'stripe';
import dotenv from 'dotenv';
import db from './db.mjs'; // Importez votre module de connexion MySQL
import { clerkMiddleware, getAuth, requireAuth } from '@clerk/express';
import mixpanel from 'mixpanel';

// Initialisation de Mixpanel avec votre token
const mixpanelClient = mixpanel.init(process.env.MIXPANEL_PROJECT_TOKEN);
dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const router = express.Router();




dotenv.config();



// Route pour créer une session de paiement
router.post('/create-checkout-session', async (req, res) => {
    const { plan, userId } = req.body; // Récupérer le userId du frontend
    console.log(userId)

    mixpanelClient.track('PAYMENT_STARTED', {
        $user_id: userId,
        plan
    });

    try {
        const prices = {
            monthly: process.env.MONTHLY_PLAN_ID,
            yearly: process.env.YEARLY_PLAN_ID,
        };

        if (!prices[plan]) {
            return res.status(400).json({ error: 'Invalid plan selected' });
        }

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'subscription',
            line_items: [
                {
                    price: prices[plan],
                    quantity: 1,
                },
            ],
            success_url: process.env.SUCCESS_URL,
            cancel_url: process.env.CANCEL_URL,
            subscription_data: {
                metadata: {
                    'userId': userId
                }
                // Ajouter userId dans les métadonnées
            },
        });

        res.json({ sessionId: session.id });
    } catch (error) {
        console.error('Error creating checkout session:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/billing-portal', requireAuth(), async (req, res) => {

    console.log('billing_portal')
    try {
        // Récupérer le userId via Clerk
        const userId = req.auth.userId;

        if (!userId) {
            return res.status(401).json({ error: 'User is not authenticated.' });
        }

        // Requête à la base de données pour récupérer le stripe_customer_id
        const query = `
            SELECT stripe_customer_id 
            FROM users 
            WHERE user_hash = ?
        `;
        db.query(query, [userId], async (err, results) => {
            if (err) {
                console.error('Database error:', err);
                return res.status(500).json({ error: 'Database error while fetching Stripe Customer ID.' });
            }

            if (results.length === 0 || !results[0].stripe_customer_id) {
                return res.status(404).json({ error: 'Stripe Customer ID not found for the user.' });
            }

            const stripeCustomerId = results[0].stripe_customer_id;

            try {
                // Créer une session pour le portail de facturation Stripe
                const session = await stripe.billingPortal.sessions.create({
                    customer: stripeCustomerId,
                    return_url: process.env.TALK_URL, // URL de retour après avoir quitté le portail
                });

                return res.status(200).json({ url: session.url });
            } catch (err) {
                console.error('Error creating Billing Portal session:', err);
                return res.status(500).json({ error: 'Failed to create Billing Portal session.' });
            }
        });
    } catch (err) {
        console.error('Unexpected error:', err);
        return res.status(500).json({ error: 'An unexpected error occurred.' });
    }
});



// Route webhook
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const sig = req.headers['stripe-signature'];

    let event;

    try {
        // Stripe nécessite le corps brut pour vérifier la signature
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
        console.error(`Webhook signature verification failed: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Gérer l'événement
    if (event.type === 'invoice.paid') {
        const invoice = event.data.object;
        const metadata = invoice.lines.data[0].metadata || {};
        const userId = metadata.userId; // Vérifiez que userId est bien dans les métadonnées
        const stripeCustomerId = invoice.customer; // Le Stripe Customer ID
        const startDate = new Date(invoice.lines.data[0].period.start * 1000);
        const endDate = new Date(invoice.lines.data[0].period.end * 1000);

        if (!userId) {
            console.error('userId is missing in the metadata');
            return res.status(400).json({ error: 'userId is missing in the metadata' });
        }

        try {
            // Insérer les informations dans la table subscriptions
            const subscriptionQuery = `
                INSERT INTO subscriptions (user_hash, start_date, end_date)
                VALUES (?, ?, ?)
            `;
            const subscriptionValues = [userId, startDate, endDate];

            db.query(subscriptionQuery, subscriptionValues, (err, result) => {
                if (err) {
                    console.error('Error inserting subscription:', err);
                    return res.status(500).json({ error: 'Database error while inserting subscription' });
                }
                console.log(`Subscription added for user: ${userId}`);
            });

            // Mettre à jour le stripe_customer_id dans la table users
            const userQuery = `
                UPDATE users
                SET stripe_customer_id = ?
                WHERE user_hash = ?
            `;
            const userValues = [stripeCustomerId, userId];

            db.query(userQuery, userValues, (err, result) => {
                if (err) {
                    console.error('Error updating stripe_customer_id:', err);
                    return res.status(500).json({ error: 'Database error while updating stripe_customer_id' });
                }
                console.log(`Stripe customer ID updated for user: ${userId}`);
            });

            mixpanelClient.track('PAYMENT_COMPLETED', {
                $user_id: userId
            });

        } catch (dbErr) {
            console.error('Database operation failed:', dbErr.message);
            return res.status(500).json({ error: 'Database operation failed' });
        }
    }

    res.status(200).json({ received: true });
});




// Route pour vérifier si un utilisateur est abonné
router.post('/is-subscribed', async (req, res) => {
    const { userId } = req.body;

    if (!userId) {
        return res.status(400).json({ error: 'userId is required' });
    }

    try {
        const query = `
            SELECT * 
            FROM subscriptions 
            WHERE user_hash = ? AND end_date > NOW()
            LIMIT 1
        `;
        db.query(query, [userId], (err, results) => {
            if (err) {
                console.error('Error querying the database:', err);
                return res.status(500).json({ error: 'Database error while checking subscription status' });
            }

            if (results.length > 0) {
                return res.json({ isSubscribed: true });
            } else {
                return res.json({ isSubscribed: false });
            }
        });
    } catch (error) {
        console.error('Error processing the request:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});




export default router;
