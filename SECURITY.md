# Security

## Exposed credentials

If you received a GitHub "Secrets detected" alert, **rotate the exposed credentials immediately**:

1. **Firebase / Google API Key**
   - Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
   - Find your project → API Keys
   - Create a new key, then delete or restrict the old one

2. **Firebase Auth password**
   - Go to [Firebase Console](https://console.firebase.google.com) → Authentication → Users
   - Reset the password for the exposed email, or delete and recreate the user

3. **Re-provision your ESP32**
   - After rotating: connect to the device’s AP (SmartPlantPro) at 192.168.4.1
   - Enter the new Firebase API key and user credentials
   - Save and let the device reconnect

## Credential handling

- **Firmware:** Credentials are no longer hardcoded. Use the WiFiManager portal or optional `src/secrets.h` (gitignored).
- **Frontend:** Use `frontend/.env.local` for Firebase config. Never commit `.env.local`.
- **Vercel:** Set environment variables in the Vercel dashboard, not in code.

## Reporting vulnerabilities

If you find a security issue, please report it privately rather than opening a public issue.
