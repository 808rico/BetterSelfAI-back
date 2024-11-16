import { Router } from 'express';
import Stripe from 'stripe';
import dotenv from 'dotenv';

dotenv.config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const router = Router();

// Route pour créer une session de paiement
router.post('/create-checkout-session', async (req, res) => {
  const { plan } = req.body; // "monthly" ou "yearly"

  try {
    const prices = {
      monthly: 'price_1QIP8gIOSPC7ROIBtxzHreNO', // Remplacez par votre ID de prix Stripe (mensuel)
      yearly: 'price_1QIP9nIOSPC7ROIBDrdvyWxw',  // Remplacez par votre ID de prix Stripe (annuel)
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
    });

    res.json({ sessionId: session.id });
  } catch (error) {
    console.error('Error creating checkout session:', error.message);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

export default router;
