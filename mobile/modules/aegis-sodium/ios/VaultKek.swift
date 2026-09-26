import ExpoModulesCore
import Foundation
import Security

/// F-1b key vault: the per-profile key-encryption key (KEK) that wraps every
/// private key the C vault hands out as a blob (docs/F1B-KEY-VAULT-DESIGN.md).
///
/// Each KEK is 32 random bytes in the Keychain, readable after the first
/// unlock and never migrated off this device (not in iCloud or encrypted
/// backups). JavaScript never sees it: it goes from here into the C vault's
/// guarded memory, and this copy is zeroed.
enum VaultKek {
  private static let service = "org.aegislink.vault.kek.v1"

  private static func query(_ slot: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: slot,
    ]
  }

  /// The profile's KEK, created on first use. The caller zeroes the returned bytes.
  static func kek(slot: String) throws -> [UInt8] {
    var q = query(slot)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &item)
    if status == errSecSuccess, let data = item as? Data {
      guard data.count == 32 else {
        throw Exception(name: "ERR_AEGIS_VAULT_KEK_LOST", description: "stored KEK is malformed")
      }
      return [UInt8](data)
    }
    guard status == errSecItemNotFound else {
      throw Exception(name: "ERR_AEGIS_VAULT", description: "Keychain read failed: \(status)")
    }
    var kek = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, kek.count, &kek) == errSecSuccess else {
      throw Exception(name: "ERR_AEGIS_VAULT", description: "no randomness for the KEK")
    }
    var add = query(slot)
    add[kSecValueData as String] = Data(kek)
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let added = SecItemAdd(add as CFDictionary, nil)
    guard added == errSecSuccess else {
      kek.withUnsafeMutableBytes { _ = memset_s($0.baseAddress, $0.count, 0, $0.count) }
      throw Exception(name: "ERR_AEGIS_VAULT", description: "Keychain write failed: \(added)")
    }
    return kek
  }

  /// Forget the profile's KEK: its blobs can never be unwrapped again (cryptographic erase).
  static func destroy(slot: String) throws {
    let status = SecItemDelete(query(slot) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw Exception(name: "ERR_AEGIS_VAULT", description: "Keychain delete failed: \(status)")
    }
  }

  /// Slot ids are short ASCII names ('self', 'slot_1').
  static func checkSlot(_ slot: String) throws -> [UInt8] {
    guard slot.range(of: "^[A-Za-z0-9_.-]{1,64}$", options: .regularExpression) != nil else {
      throw Exception(name: "ERR_AEGIS_VAULT", description: "bad vault slot name")
    }
    return Array(slot.utf8)
  }
}
