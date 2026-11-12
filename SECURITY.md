# Security

Do not put API keys, administrator tokens, databases or encryption keys in GitHub issues, screenshots or pull requests. Report a suspected vulnerability privately through the repository's Security tab if private reporting is enabled; otherwise open an issue requesting a private contact without exploit details or secrets.

The gateway must be placed behind HTTPS for remote use. Its bootstrap administrator token grants full control of all provider and member keys. Keep it only on administrator devices, in the DSH credentials service. The panel supports unencrypted HTTP only for loopback development.

Provider keys are encrypted with a separate AES-256-GCM key. The administrator and filesystem owner can still access them. Member keys are random and digest-only. Deleting a key revokes future authentication while preserving historical usage and reservations.

Only requests made through the managed gateway are accounted for. Requests sent directly to DeepSeek with an original provider key are outside its control. Costs are estimates from provider receipts and a maintained tariff table, not account invoice data.

Back up the database, encryption key and administrator token together. A compromised member key should be deleted or rotated; a compromised provider key must also be revoked on the DeepSeek platform. This is an early release and has not received an independent security audit.
