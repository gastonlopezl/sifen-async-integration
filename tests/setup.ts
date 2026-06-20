// Test env: a fixed issuer with a valid RUC + check digit and a wide timbrado
// window so the guards pass deterministically. stub mode means no certificate
// and no SET calls, so the full pipeline runs in-process. Set before any module
// that reads env is imported.
//
// 80017556-5 is a valid RUC + Modulo 11 check digit pair, used here so the RUC
// guard passes without a real taxpayer's number.
process.env.SIFEN_ENV = "test";
process.env.SIFEN_MODE = "stub";
process.env.ISSUER_RUC = "80017556";
process.env.ISSUER_DV = "5";
process.env.ISSUER_TIMBRADO = "12345678";
process.env.ISSUER_TIMBRADO_START = "2026-01-01";
process.env.ISSUER_TIMBRADO_END = "2030-12-31";
process.env.ISSUER_ESTABLISHMENT = "001";
process.env.ISSUER_EXPEDITION_POINT = "001";
process.env.SIFEN_CERT_PEM = "";
process.env.SIFEN_PRIVATE_KEY_PEM = "";
process.env.SIFEN_ENCRYPTION_KEY = "";
process.env.DATABASE_URL = "postgresql://localhost:5432/test";
process.env.SIFEN_AUTO_DISPATCH = "false";
