package expo.modules.aegissodium

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import expo.modules.kotlin.exception.CodedException
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * F-1b key vault: the per-profile key-encryption key (KEK) that wraps every
 * private key the C vault hands out as a blob (docs/F1B-KEY-VAULT-DESIGN.md).
 *
 * Each KEK is 32 random bytes, stored in the app's private preferences
 * encrypted (AES-256-GCM) under one NON-EXPORTABLE Android Keystore key
 * (StrongBox when the device has one). JavaScript never sees a KEK: it goes
 * from here straight into the C vault's guarded memory, and this copy is zeroed.
 *
 * If the Keystore key is gone (keystore reset, app data restored onto another
 * device), the stored KEK cannot be decrypted: ERR_AEGIS_VAULT_KEK_LOST, never
 * a silently regenerated KEK (that would orphan every blob without saying so).
 */
internal object VaultKek {
  private const val KEYSTORE = "AndroidKeyStore"
  private const val WRAP_ALIAS = "aegis_vault_kek_wrap_v1"
  private const val PREFS = "aegis_vault_v1"
  private const val GCM_IV = 12
  private const val GCM_TAG_BITS = 128

  private fun prefKey(slot: String) = "kek_$slot"

  private fun wrapKey(create: Boolean): SecretKey? {
    val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    (ks.getKey(WRAP_ALIAS, null) as? SecretKey)?.let { return it }
    if (!create) return null
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
    fun spec(strongBox: Boolean) =
      KeyGenParameterSpec.Builder(WRAP_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .setRandomizedEncryptionRequired(true)
        .apply { if (strongBox && Build.VERSION.SDK_INT >= 28) setIsStrongBoxBacked(true) }
        .build()
    if (Build.VERSION.SDK_INT >= 28) {
      try {
        gen.init(spec(true))
        return gen.generateKey()
      } catch (_: StrongBoxUnavailableException) {
        // No secure element: the TEE-backed Keystore below.
      }
    }
    gen.init(spec(false))
    return gen.generateKey()
  }

  /** The profile's KEK, created on first use. The caller zeroes the returned array. */
  fun kek(context: Context, slot: String): ByteArray {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val stored = prefs.getString(prefKey(slot), null)
    if (stored != null) {
      val key = wrapKey(create = false) ?: throw lost("the vault's Keystore key is missing")
      val raw = Base64.decode(stored, Base64.NO_WRAP)
      if (raw.size <= GCM_IV) throw lost("stored KEK is malformed")
      return try {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, raw, 0, GCM_IV))
        cipher.doFinal(raw, GCM_IV, raw.size - GCM_IV)
      } catch (e: Exception) {
        throw lost("stored KEK does not decrypt: ${e.javaClass.simpleName}")
      }
    }
    val kek = ByteArray(32).also { SecureRandom().nextBytes(it) }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, wrapKey(create = true))
    val ct = cipher.doFinal(kek)
    val out = cipher.iv + ct
    if (!prefs.edit().putString(prefKey(slot), Base64.encodeToString(out, Base64.NO_WRAP)).commit()) {
      kek.fill(0)
      throw CodedException("ERR_AEGIS_VAULT", "could not persist the vault KEK", null)
    }
    return kek
  }

  /** Forget the profile's KEK: its blobs can never be unwrapped again (cryptographic erase). */
  fun destroy(context: Context, slot: String) {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    if (!prefs.edit().remove(prefKey(slot)).commit()) {
      throw CodedException("ERR_AEGIS_VAULT", "could not delete the vault KEK", null)
    }
  }

  private fun lost(why: String) = CodedException("ERR_AEGIS_VAULT_KEK_LOST", why, null)
}
