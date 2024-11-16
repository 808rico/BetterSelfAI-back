import express from 'express';
import Stripe from 'stripe';
import dotenv from 'dotenv';

dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const router = express.Router();



dotenv.config();



// Route pour créer une session de paiement
router.post('/create-checkout-session', async (req, res) => {
    const { plan, userId } = req.body; // Récupérer le userId du frontend

    try {
        const prices = {
            monthly: 'price_1QIP8gIOSPC7ROIBtxzHreNO',
            yearly: 'price_1QIP9nIOSPC7ROIBDrdvyWxw',
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
            metadata: {
                userId, // Ajouter userId dans les métadonnées
            },
        });

        res.json({ sessionId: session.id });
    } catch (error) {
        console.error('Error creating checkout session:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});


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

        console.log(invoice)
        const subscription = invoice.subscription;
        const userId = invoice.metadata.userId;
        const startDate = invoice.lines.data[0].period.start;
        const endDate = invoice.lines.data[0].period.end;

        console.log(`Invoice paid for user: ${userId}`);
        console.log(`Subscription starts at: ${new Date(startDate * 1000)}`);
        console.log(`Subscription ends at: ${new Date(endDate * 1000)}`);

        // Insérez les informations dans votre base de données ici
    }

    res.status(200).json({ received: true });
});





export default router;
