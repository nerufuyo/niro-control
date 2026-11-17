// Pairing, the device's side: SRP with the code typed on the device, then the key the daemon gives. See
// crates/island-daemon/src/device/enroll.rs, which this must match.
#pragma once
#include <stdint.h>

typedef enum {
    PAIR_OK,
    PAIR_NETWORK,  // the connection failed
    PAIR_CODE,     // the daemon dropped us at once: the code was wrong
    PAIR_DENIED,   // the user did not allow it, or did not answer
    PAIR_PROTOCOL, // something that is not the protocol
} pair_result_t;

/** Runs the exchange on `fd`. On PAIR_OK the daemon's id and this device's new key are filled in. */
pair_result_t pair_with_daemon(int fd, const char *code, const char *device_id, const char *name,
                               uint8_t daemon_id[16], uint8_t device_key[32]);
