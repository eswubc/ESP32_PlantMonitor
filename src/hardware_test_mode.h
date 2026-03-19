/**
 * Hardware Test Mode — BME280, float switch, MAX98357 speaker, INMP441 mic.
 * Only compiled when HARDWARE_TEST_MODE is defined (e.g. esp32-s3-zero-hwtest env).
 */
#pragma once

void hardwareTestSetup();
void hardwareTestLoop();
