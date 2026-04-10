/**
 * Firebase default credentials (used when NVS has no saved values).
 *
 * These are compiled into the firmware as fallback defaults.
 * If the user enters new values via the WiFiManager portal, those
 * are saved in NVS and take priority over these defaults.
 *
 * To override for local dev: edit secrets.h (gitignored).
 */
#pragma once

#if __has_include("secrets.h")
#include "secrets.h"
#endif

// All values must be provisioned via WiFiManager portal or src/secrets.h
#ifndef FIREBASE_API_KEY
#define FIREBASE_API_KEY ""
#endif

#ifndef FIREBASE_DB_URL
#define FIREBASE_DB_URL ""
#endif

#ifndef FIREBASE_USER_EMAIL
#define FIREBASE_USER_EMAIL ""
#endif

#ifndef FIREBASE_USER_PASSWORD
#define FIREBASE_USER_PASSWORD ""
#endif
