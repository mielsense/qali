import Foundation
import Security

private let maximumLineBytes = 128 * 1024
private let maximumSecretBytes = 64 * 1024
private let maximumRequests = 32
private let allowedServices: Set<String> = [
    "com.qali.desktop",
    "com.qali.desktop.dev",
    "com.qali.desktop.test",
]
private let allowedAccounts: Set<String> = [
    "convex-instance-root-secret",
    "convex-admin-credential",
    "local-jwt-signing-key",
    "google-oauth-client-config",
    "google-refresh-token",
    "google-account-metadata",
    "google-account-v2-0",
    "google-account-v2-1",
    "google-account-v2-2",
    "google-account-v2-3",
    "google-account-v2-4",
    "google-account-v2-5",
    "google-account-v2-6",
    "google-account-v2-7",
]

private func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let line = String(data: data, encoding: .utf8) else {
        FileHandle.standardOutput.write(Data("{\"ok\":false,\"error\":\"encoding-failed\"}\n".utf8))
        return
    }
    FileHandle.standardOutput.write(Data("\(line)\n".utf8))
}

private func query(service: String, account: String) -> [String: Any] {
    [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
    ]
}

private func securityError(_ status: OSStatus) -> [String: Any] {
    ["ok": false, "error": "security-status-\(status)"]
}

private func process(_ line: Data) {
    guard line.count <= maximumLineBytes,
          let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
          let operation = object["operation"] as? String,
          let service = object["service"] as? String,
          let account = object["account"] as? String,
          allowedServices.contains(service),
          allowedAccounts.contains(account) else {
        emit(["ok": false, "error": "invalid-request"])
        return
    }

    var item = query(service: service, account: account)
    switch operation {
    case "get":
        item[kSecReturnData as String] = true
        item[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(item as CFDictionary, &result)
        if status == errSecItemNotFound {
            emit(["ok": true, "value": NSNull()])
        } else if status == errSecSuccess,
                  let data = result as? Data,
                  data.count <= maximumSecretBytes,
                  let value = String(data: data, encoding: .utf8) {
            emit(["ok": true, "value": value])
        } else {
            emit(securityError(status))
        }

    case "set":
        guard let value = object["value"] as? String,
              let valueData = value.data(using: .utf8),
              valueData.count <= maximumSecretBytes else {
            emit(["ok": false, "error": "invalid-value"])
            return
        }
        let attributes = [kSecValueData as String: valueData]
        var status = SecItemUpdate(item as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            item[kSecValueData as String] = valueData
            status = SecItemAdd(item as CFDictionary, nil)
        }
        emit(status == errSecSuccess ? ["ok": true] : securityError(status))

    case "delete":
        let status = SecItemDelete(item as CFDictionary)
        emit(status == errSecSuccess || status == errSecItemNotFound
             ? ["ok": true]
             : securityError(status))

    default:
        emit(["ok": false, "error": "invalid-operation"])
    }
}

private let input = FileHandle.standardInput
private var buffer = Data()
private var requestCount = 0

while requestCount < maximumRequests {
    let chunk = input.readData(ofLength: 4096)
    if chunk.isEmpty && buffer.isEmpty { break }
    buffer.append(chunk)

    while let newline = buffer.firstRange(of: Data([0x0A])) {
        let line = buffer[..<newline.lowerBound]
        buffer.removeSubrange(...newline.lowerBound)
        guard !line.isEmpty, line.count <= maximumLineBytes else {
            emit(["ok": false, "error": "request-too-large"])
            exit(EXIT_FAILURE)
        }
        process(Data(line))
        requestCount += 1
        if requestCount >= maximumRequests { break }
    }

    if buffer.count > maximumLineBytes {
        emit(["ok": false, "error": "request-too-large"])
        exit(EXIT_FAILURE)
    }
    if chunk.isEmpty {
        if !buffer.isEmpty {
            process(buffer)
            requestCount += 1
        }
        break
    }
}
