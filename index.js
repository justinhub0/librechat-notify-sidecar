const express = require('express');
const { Expo } = require('expo-server-sdk');

const app = express();
app.use(express.json());

const expo = new Expo();

// Active watch jobs: Map<conversationId, { pushToken, authToken, baseURL, interval, startedAt }>
const watches = new Map();

const POLL_INTERVAL_MS = 15_000;       // 15 seconds
const MAX_WATCH_DURATION_MS = 45 * 60_000; // 45 minutes max

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', activeWatches: watches.size });
});

// Start watching a conversation for completion
app.post('/watch', (req, res) => {
  const { pushToken, conversationId, authToken, baseURL } = req.body;

  if (!pushToken || !conversationId || !authToken || !baseURL) {
    return res.status(400).json({ error: 'Missing required fields: pushToken, conversationId, authToken, baseURL' });
  }

  if (!Expo.isExpoPushToken(pushToken)) {
    return res.status(400).json({ error: 'Invalid Expo push token' });
  }

  // If already watching this conversation, reset it
  if (watches.has(conversationId)) {
    clearInterval(watches.get(conversationId).interval);
    watches.delete(conversationId);
  }

  console.log(`[Watch] Starting: ${conversationId}`);

  const startedAt = Date.now();
  let lastMessageCount = 0;

  const interval = setInterval(async () => {
    // Auto-expire after max duration
    if (Date.now() - startedAt > MAX_WATCH_DURATION_MS) {
      console.log(`[Watch] Expired (timeout): ${conversationId}`);
      clearInterval(interval);
      watches.delete(conversationId);
      return;
    }

    try {
      const response = await fetch(`${baseURL}/api/messages/${conversationId}`, {
        headers: {
          'Authorization': authToken,
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        console.log(`[Watch] API error ${response.status} for ${conversationId}`);
        // If 401/403, token expired — stop watching
        if (response.status === 401 || response.status === 403) {
          console.log(`[Watch] Auth failed, stopping: ${conversationId}`);
          clearInterval(interval);
          watches.delete(conversationId);
        }
        return;
      }

      const messages = await response.json();

      if (!Array.isArray(messages) || messages.length === 0) {
        return;
      }

      // Find the last message
      const lastMessage = messages[messages.length - 1];
      const isFromAssistant = lastMessage.isCreatedByUser === false;
      const isComplete = !lastMessage.unfinished;

      console.log(`[Watch] ${conversationId}: ${messages.length} msgs, lastIsAssistant=${isFromAssistant}, complete=${isComplete}`);

      if (isFromAssistant && isComplete) {
        // AI response is done! Send push notification
        console.log(`[Watch] Complete! Sending notification for: ${conversationId}`);

        const senderName = lastMessage.sender || 'AI';

        try {
          await expo.sendPushNotificationsAsync([{
            to: pushToken,
            title: 'LibreChat',
            body: `${senderName} has finished responding`,
            sound: 'default',
            data: { conversationId },
            categoryIdentifier: 'message',
          }]);
          console.log(`[Watch] Notification sent for: ${conversationId}`);
        } catch (pushErr) {
          console.error(`[Watch] Push failed for ${conversationId}:`, pushErr.message);
        }

        // Stop watching
        clearInterval(interval);
        watches.delete(conversationId);
      }
    } catch (err) {
      console.error(`[Watch] Fetch error for ${conversationId}:`, err.message);
    }
  }, POLL_INTERVAL_MS);

  watches.set(conversationId, { pushToken, authToken, baseURL, interval, startedAt });

  res.json({ status: 'watching', conversationId });
});

// Stop watching a conversation
app.delete('/watch/:conversationId', (req, res) => {
  const { conversationId } = req.params;

  if (watches.has(conversationId)) {
    clearInterval(watches.get(conversationId).interval);
    watches.delete(conversationId);
    console.log(`[Watch] Stopped: ${conversationId}`);
    res.json({ status: 'stopped', conversationId });
  } else {
    res.status(404).json({ error: 'Not watching this conversation' });
  }
});

// List active watches (for debugging)
app.get('/watches', (_req, res) => {
  const active = [];
  for (const [convoId, watch] of watches) {
    active.push({
      conversationId: convoId,
      startedAt: new Date(watch.startedAt).toISOString(),
      elapsedMs: Date.now() - watch.startedAt,
    });
  }
  res.json({ watches: active });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[Sidecar] Listening on port ${PORT}`);
  console.log(`[Sidecar] Poll interval: ${POLL_INTERVAL_MS / 1000}s, Max watch: ${MAX_WATCH_DURATION_MS / 60000}min`);
});
