/**
 * Stripe Billing Integration Module
 * Handles subscription management, checkout, and webhook processing
 */


// ════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════

const STRIPE_WEBHOOK_SECRET_HEADER = 'stripe-signature';

// Stripe product pricing (from environment variables)
// ENV: STRIPE_PRODUCT_ID_PRO, STRIPE_PRICE_ID_PRO, etc.
const PRODUCTS = {
  PRO: {
    name: 'Cloud Sync Pro',
    priceId: null, // Will be set from env at runtime
    monthlyPrice: 300, // $3.00 in cents
    tier: 'pro',
    features: ['Cloud Sync', 'Multi-device', '30-day history']
  }
};

// ════════════════════════════════════════════════════════════
// CHECKOUT SESSION CREATION
// ════════════════════════════════════════════════════════════

/**
 * Create a Stripe checkout session for subscription
 * Returns Stripe session URL for redirect
 */
export async function createCheckoutSession(env, userId, userEmail, plan = 'pro') {
  try {
    if (!env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY not configured');
    }

    const priceId = env.STRIPE_PRICE_ID_PRO || PRODUCTS[plan.toUpperCase()].priceId;
    if (!priceId) {
      throw new Error(`Price ID not configured for plan: ${plan}`);
    }

    const sessionData = {
      customer_email: userEmail,
      client_reference_id: userId,
      line_items: [
        {
          price: priceId,
          quantity: 1
        }
      ],
      mode: 'subscription',
      payment_method_types: ['card'],
      success_url: `${env.APP_URL}/billing?success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.APP_URL}/billing?cancelled=true`,
      subscription_data: {
        metadata: {
          user_id: userId,
          plan: plan
        }
      },
      metadata: {
        user_id: userId,
        plan: plan,
        created_at: new Date().toISOString()
      }
    };

    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams(flattenObject(sessionData)).toString()
    });

    if (!response.ok) {
      const error = await response.json();
      console.error('[STRIPE] Checkout creation failed:', error);
      throw new Error(`Stripe error: ${error.error?.message || 'Unknown error'}`);
    }

    const session = await response.json();

    // Log checkout attempt
    await logCheckoutEvent(env, userId, 'checkout_session_created', {
      session_id: session.id,
      plan,
      amount: PRODUCTS[plan.toUpperCase()].monthlyPrice
    });

    return {
      success: true,
      url: session.url,
      sessionId: session.id
    };
  } catch (error) {
    console.error('[STRIPE] Checkout session creation error:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

// ════════════════════════════════════════════════════════════
// WEBHOOK PROCESSING
// ════════════════════════════════════════════════════════════

/**
 * Verify Stripe webhook signature
 * Protects against spoofed webhooks
 */
export async function verifyWebhookSignature(request, env) {
  try {
    const signature = request.headers.get(STRIPE_WEBHOOK_SECRET_HEADER);
    if (!signature) {
      return { valid: false, reason: 'Missing signature header' };
    }

    const body = await request.text();
    const timestamp = signature.split(',')[0].split('=')[1];
    const receivedSignature = signature.split('v1=')[1];

    // Construct signed content
    const signedContent = `${timestamp}.${body}`;

    // Sign with webhook secret
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(env.STRIPE_WEBHOOK_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(signedContent));
    const hexSignature = Array.from(new Uint8Array(signed))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    const isValid = hexSignature === receivedSignature;

    // Check timestamp (must be within 5 minutes)
    const webhookTime = parseInt(timestamp) * 1000;
    const timeDiff = Date.now() - webhookTime;
    if (timeDiff > 5 * 60 * 1000) {
      return { valid: false, reason: 'Webhook timestamp too old' };
    }

    return { valid: isValid, reason: isValid ? null : 'Invalid signature' };
  } catch (error) {
    console.error('[STRIPE] Webhook verification error:', error.message);
    return { valid: false, reason: `Verification error: ${error.message}` };
  }
}

/**
 * Process Stripe webhook events
 * Handles: checkout.session.completed, payment_intent.succeeded, etc.
 */
export async function processWebhookEvent(env, event) {
  try {
    const { type, data } = event;

    console.log(`[STRIPE] Processing webhook: ${type}`);

    switch (type) {
      case 'checkout.session.completed':
        return await handleCheckoutSessionCompleted(env, data.object);

      case 'customer.subscription.updated':
        return await handleSubscriptionUpdated(env, data.object);

      case 'customer.subscription.deleted':
        return await handleSubscriptionDeleted(env, data.object);

      case 'invoice.payment_succeeded':
        return await handleInvoicePaymentSucceeded(env, data.object);

      case 'invoice.payment_failed':
        return await handleInvoicePaymentFailed(env, data.object);

      default:
        console.log(`[STRIPE] Ignoring event type: ${type}`);
        return { processed: false, reason: 'Event type not handled' };
    }
  } catch (error) {
    console.error('[STRIPE] Webhook processing error:', error.message);
    return { processed: false, error: error.message };
  }
}

/**
 * Handle: checkout.session.completed
 * User completed payment, create/update subscription in our DB
 */
async function handleCheckoutSessionCompleted(env, session) {
  try {
    const { client_reference_id: userId, customer, subscription: subscriptionId, metadata } = session;

    if (!userId) {
      console.warn('[STRIPE] checkout.session.completed missing client_reference_id');
      return { processed: false, reason: 'Missing user ID' };
    }

    const plan = metadata?.plan || 'pro';

    // Fetch subscription details
    const subscription = await fetchStripeObject('subscriptions', subscriptionId, env);
    if (!subscription) {
      throw new Error(`Failed to fetch subscription: ${subscriptionId}`);
    }

    // Update user tier in DB
    await env.DB.prepare(
      'UPDATE users SET subscription_tier = ? WHERE id = ?'
    ).bind(plan, userId).run();

    // Store Stripe subscription mapping
    await env.DB.prepare(
      `INSERT INTO stripe_subscriptions (user_id, stripe_customer_id, stripe_subscription_id, stripe_product_id, tier, status, current_period_start, current_period_end, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         stripe_subscription_id = excluded.stripe_subscription_id,
         tier = excluded.tier,
         status = excluded.status,
         current_period_start = excluded.current_period_start,
         current_period_end = excluded.current_period_end,
         updated_at = datetime('now')`
    ).bind(
      userId,
      customer,
      subscriptionId,
      subscription.items.data[0]?.product || null,
      plan,
      subscription.status,
      new Date(subscription.current_period_start * 1000).toISOString(),
      new Date(subscription.current_period_end * 1000).toISOString()
    ).run();

    // Log event
    await logCheckoutEvent(env, userId, 'checkout_completed', {
      subscription_id: subscriptionId,
      customer_id: customer,
      plan,
      period_start: subscription.current_period_start,
      period_end: subscription.current_period_end
    });

    console.log(`[STRIPE] User ${userId} subscribed to ${plan}`);
    return { processed: true, userId, plan };
  } catch (error) {
    console.error('[STRIPE] Failed to handle checkout completion:', error.message);
    return { processed: false, error: error.message };
  }
}

/**
 * Handle: customer.subscription.updated
 * Subscription status changed (e.g., renewed, upgraded, downgraded)
 */
async function handleSubscriptionUpdated(env, subscription) {
  try {
    const userId = subscription.metadata?.user_id;
    if (!userId) {
      console.warn('[STRIPE] subscription.updated missing user_id in metadata');
      return { processed: false };
    }

    const newStatus = subscription.status;

    // Update tier based on status
    let tier = 'free';
    if (newStatus === 'active' || newStatus === 'trialing') {
      tier = subscription.metadata?.plan || 'pro';
    }

    // Update user and subscription record
    await env.DB.prepare(
      'UPDATE users SET subscription_tier = ?, updated_at = datetime("now") WHERE id = ?'
    ).bind(tier, userId).run();

    await env.DB.prepare(
      `UPDATE stripe_subscriptions
       SET status = ?, tier = ?, updated_at = datetime('now')
       WHERE stripe_subscription_id = ?`
    ).bind(newStatus, tier, subscription.id).run();

    await logCheckoutEvent(env, userId, 'subscription_updated', {
      subscription_id: subscription.id,
      new_status: newStatus,
      new_tier: tier
    });

    console.log(`[STRIPE] Subscription ${subscription.id} updated to ${newStatus}`);
    return { processed: true, userId, newStatus };
  } catch (error) {
    console.error('[STRIPE] Failed to handle subscription update:', error.message);
    return { processed: false, error: error.message };
  }
}

/**
 * Handle: customer.subscription.deleted
 * User cancelled subscription, revert to free tier
 */
async function handleSubscriptionDeleted(env, subscription) {
  try {
    const userId = subscription.metadata?.user_id;
    if (!userId) {
      console.warn('[STRIPE] subscription.deleted missing user_id in metadata');
      return { processed: false };
    }

    // Revert to free tier
    await env.DB.prepare(
      'UPDATE users SET subscription_tier = ?, updated_at = datetime("now") WHERE id = ?'
    ).bind('free', userId).run();

    // Mark subscription as deleted
    await env.DB.prepare(
      'UPDATE stripe_subscriptions SET status = "cancelled" WHERE stripe_subscription_id = ?'
    ).bind(subscription.id).run();

    await logCheckoutEvent(env, userId, 'subscription_cancelled', {
      subscription_id: subscription.id
    });

    console.log(`[STRIPE] Subscription ${subscription.id} cancelled for user ${userId}`);
    return { processed: true, userId, cancelled: true };
  } catch (error) {
    console.error('[STRIPE] Failed to handle subscription deletion:', error.message);
    return { processed: false, error: error.message };
  }
}

/**
 * Handle: invoice.payment_succeeded
 * Recurring charge succeeded (monthly renewal)
 */
async function handleInvoicePaymentSucceeded(env, invoice) {
  try {
    // Fetch subscription to get user ID
    const subscription = await fetchStripeObject('subscriptions', invoice.subscription, env);
    if (!subscription) {
      console.warn('[STRIPE] Could not find subscription for invoice:', invoice.subscription);
      return { processed: false };
    }

    const userId = subscription.metadata?.user_id;
    if (!userId) {
      console.warn('[STRIPE] Subscription missing user_id in metadata');
      return { processed: false };
    }

    // Update subscription timestamps
    await env.DB.prepare(
      `UPDATE stripe_subscriptions
       SET current_period_start = ?, current_period_end = ?
       WHERE stripe_subscription_id = ?`
    ).bind(
      new Date(subscription.current_period_start * 1000).toISOString(),
      new Date(subscription.current_period_end * 1000).toISOString(),
      subscription.id
    ).run();

    await logCheckoutEvent(env, userId, 'payment_succeeded', {
      invoice_id: invoice.id,
      amount: invoice.amount_paid,
      subscription_id: subscription.id
    });

    console.log(`[STRIPE] Payment succeeded for user ${userId}, amount: ${invoice.amount_paid}`);
    return { processed: true, userId };
  } catch (error) {
    console.error('[STRIPE] Failed to handle successful payment:', error.message);
    return { processed: false, error: error.message };
  }
}

/**
 * Handle: invoice.payment_failed
 * Recurring charge failed (billing issue)
 */
async function handleInvoicePaymentFailed(env, invoice) {
  try {
    const subscription = await fetchStripeObject('subscriptions', invoice.subscription, env);
    if (!subscription) {
      console.warn('[STRIPE] Could not find subscription for failed invoice:', invoice.subscription);
      return { processed: false };
    }

    const userId = subscription.metadata?.user_id;
    if (!userId) {
      console.warn('[STRIPE] Subscription missing user_id in metadata');
      return { processed: false };
    }

    await logCheckoutEvent(env, userId, 'payment_failed', {
      invoice_id: invoice.id,
      amount: invoice.amount_due,
      attempt_count: invoice.attempt_count,
      subscription_id: subscription.id
    });

    console.log(`[STRIPE] Payment failed for user ${userId}, invoice: ${invoice.id}`);
    return { processed: true, userId, needsRetry: true };
  } catch (error) {
    console.error('[STRIPE] Failed to handle failed payment:', error.message);
    return { processed: false, error: error.message };
  }
}

// ════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ════════════════════════════════════════════════════════════

/**
 * Fetch Stripe object (subscription, customer, invoice, etc.)
 */
async function fetchStripeObject(objectType, objectId, env) {
  try {
    const response = await fetch(`https://api.stripe.com/v1/${objectType}/${objectId}`, {
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`
      }
    });

    if (!response.ok) {
      console.error(`[STRIPE] Failed to fetch ${objectType}:`, response.status);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error(`[STRIPE] Error fetching ${objectType}:`, error.message);
    return null;
  }
}

/**
 * Flatten nested object for URL encoding in form data
 * Example: { a: { b: 1 } } → { 'a[b]': 1 }
 */
function flattenObject(obj, prefix = '') {
  const flattened = {};

  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}[${key}]` : key;

    if (value === null || value === undefined) {
      continue;
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(flattened, flattenObject(value, newKey));
    } else if (Array.isArray(value)) {
      value.forEach((item, idx) => {
        if (typeof item === 'object') {
          Object.assign(flattened, flattenObject(item, `${newKey}[${idx}]`));
        } else {
          flattened[`${newKey}[${idx}]`] = item;
        }
      });
    } else {
      flattened[newKey] = value;
    }
  }

  return flattened;
}

/**
 * Log billing/checkout events for analytics
 */
async function logCheckoutEvent(env, userId, eventType, metadata = {}) {
  try {
    await env.DB.prepare(
      `INSERT INTO analytics_events (user_id, event_type, event_data, created_at)
       VALUES (?, ?, ?, datetime('now'))`
    ).bind(userId, `billing:${eventType}`, JSON.stringify(metadata)).run();
  } catch (error) {
    console.warn('[STRIPE] Failed to log checkout event:', error.message);
  }
}

/**
 * Get current subscription status for user
 */
export async function getUserSubscription(env, userId) {
  try {
    const subscription = await env.DB.prepare(
      'SELECT stripe_subscription_id, tier, status, current_period_end FROM stripe_subscriptions WHERE user_id = ?'
    ).bind(userId).first();

    if (!subscription) {
      return { tier: 'free', status: null };
    }

    // Check if subscription period has ended (cancelled but not yet marked)
    if (subscription.current_period_end) {
      const periodEnd = new Date(subscription.current_period_end).getTime();
      if (Date.now() > periodEnd && subscription.status === 'active') {
        // Subscription ended, downgrade to free
        await env.DB.prepare(
          'UPDATE users SET subscription_tier = ? WHERE id = ?'
        ).bind('free', userId).run();
        return { tier: 'free', status: 'expired' };
      }
    }

    return {
      tier: subscription.tier,
      status: subscription.status,
      subscriptionId: subscription.stripe_subscription_id,
      periodEnd: subscription.current_period_end
    };
  } catch (error) {
    console.error('[STRIPE] Error fetching user subscription:', error.message);
    return { tier: 'free', status: 'error' };
  }
}

export default {
  createCheckoutSession,
  verifyWebhookSignature,
  processWebhookEvent,
  getUserSubscription,
  PRODUCTS
};
