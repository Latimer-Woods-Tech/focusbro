// API Communication and Network Utilities
export function initAPI() {
  // Initialize API state
  window.appState.api = {
    baseURL: window.location.origin,
    endpoints: {
      auth: '/api/auth',
      sync: '/api/sync',
      analytics: '/api/analytics'
    },
    queue: [],
    isOnline: navigator.onLine,
    retryAttempts: 3
  };

  // Listen for online/offline events
  window.addEventListener('online', () => {
    window.appState.api.isOnline = true;
    processAPIQueue();
  });

  window.addEventListener('offline', () => {
    window.appState.api.isOnline = false;
  });
}

// Make authenticated API request
window.apiRequest = async function(endpoint, options = {}) {
  const {
    method = 'GET',
    data = null,
    headers = {},
    retryOnFail = true
  } = options;

  // Check if online
  if (!window.appState.api.isOnline) {
    // Queue request for when we come back online
    queueAPIRequest(endpoint, options);
    return { success: false, error: 'Offline - request queued' };
  }

  const url = `${window.appState.api.baseURL}${endpoint}`;
  const requestOptions = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    }
  };

  // Add body for non-GET requests
  if (data && method !== 'GET') {
    requestOptions.body = JSON.stringify(data);
  }

  let attempts = 0;
  while (attempts < window.appState.api.retryAttempts) {
    try {
      const response = await fetch(url, requestOptions);
      const responseData = await response.json();

      if (response.ok) {
        return { success: true, data: responseData };
      } else {
        // Handle specific error codes
        if (response.status === 401) {
          // Cookie session expired, try the short server-side refresh grace.
          const refreshResult = await refreshAuthToken();
          if (refreshResult.success) {
            // Retry with the rotated HttpOnly cookie.
            attempts++;
            continue;
          }
        }

        return {
          success: false,
          error: responseData.error || `HTTP ${response.status}`,
          status: response.status
        };
      }
    } catch (error) {
      console.warn(`API request failed (attempt ${attempts + 1}):`, error);

      if (!retryOnFail || attempts >= window.appState.api.retryAttempts - 1) {
        return { success: false, error: error.message };
      }

      attempts++;
      // Exponential backoff
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempts) * 1000));
    }
  }

  return { success: false, error: 'Max retry attempts exceeded' };
};

// Queue API request for offline handling
function queueAPIRequest(endpoint, options) {
  window.appState.api.queue.push({
    endpoint,
    options,
    timestamp: Date.now()
  });

  // Limit queue size
  if (window.appState.api.queue.length > 50) {
    window.appState.api.queue.shift(); // Remove oldest
  }
}

// Process queued API requests when back online
async function processAPIQueue() {
  if (window.appState.api.queue.length === 0) return;

  const queue = [...window.appState.api.queue];
  window.appState.api.queue = [];

  for (const request of queue) {
    try {
      await apiRequest(request.endpoint, request.options);
    } catch (e) {
      console.warn('Failed to process queued request:', e);
      // Re-queue failed requests
      window.appState.api.queue.push(request);
    }
  }
}

// Refresh authentication token
async function refreshAuthToken() {
  try {
    const response = await fetch(`${window.appState.api.baseURL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    if (response.ok) {
      return { success: true };
    } else {
      // Refresh failed, user needs to re-authenticate
      clearAuthData();
      return { success: false, error: 'Token refresh failed' };
    }
  } catch (error) {
    console.warn('Token refresh error:', error);
    return { success: false, error: error.message };
  }
}

// Clear authentication data
function clearAuthData() {
  safeStorageRemove('fbAuthToken');
  safeStorageRemove('fbUser');
  // Trigger re-authentication flow
  if (window.showAuthModal) {
    window.showAuthModal();
  }
}

// Sync local data to server
window.syncData = async function() {
  const events = getStoredJSON('fbEvents', []);
  const unsyncedEvents = events.filter(e => !e.synced);

  if (unsyncedEvents.length === 0) {
    return { success: true, message: 'No data to sync' };
  }

  const result = await apiRequest('/api/sync', {
    method: 'POST',
    data: { events: unsyncedEvents }
  });

  if (result.success) {
    // Mark events as synced
    events.forEach(e => {
      if (!e.synced) e.synced = true;
    });
    setStoredJSON('fbEvents', events);
  }

  return result;
};

// Get user profile from server
window.getUserProfile = async function() {
  const result = await apiRequest('/api/user/profile');

  if (result.success) {
    setStoredJSON('fbUser', result.data);
    return result.data;
  }

  return null;
};

// Update user settings
window.updateUserSettings = async function(settings) {
  const result = await apiRequest('/api/user/settings', {
    method: 'PUT',
    data: settings
  });

  if (result.success) {
    // Update local settings
    const user = getStoredJSON('fbUser', {});
    user.settings = { ...user.settings, ...settings };
    setStoredJSON('fbUser', user);
  }

  return result;
};

// Check API connectivity
window.checkAPIHealth = async function() {
  try {
    const response = await fetch(`${window.appState.api.baseURL}/api/health`, {
      method: 'GET',
      cache: 'no-cache'
    });
    return response.ok;
  } catch (e) {
    return false;
  }
};
