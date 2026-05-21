---
name: secure-webrtc-signaling
description: Skill para la implementación de llamadas WebRTC end-to-end con seguridad DTLS-SRTP, coturn y negociación Socket.IO sin fuga de metadatos.
---

# Llamadas WebRTC E2EE con DTLS-SRTP y Señalización Segura

Esta skill proporciona las directrices y estándares para construir el canal de comunicación en tiempo real de voz y video en AegisLink, garantizando la confidencialidad total y el anonimato de la conexión IP.

## 1. Protección de la IP (Prevención de Fuga de Red)
Por defecto, las conexiones directas WebRTC (Peer-to-Peer) revelan la dirección IP pública y local de los participantes en los candidatos ICE.

### Mitigación en AegisLink
- **Forzar Relay TURN**: Siempre priorizar la conexión a través de los servidores TURN propios del relay, evitando el establecimiento directo de P2P que revelaría la IP al otro participante si el nivel de privacidad está configurado al máximo ("Cero Fugas").
- **Configuración de RTCConfiguration**:
  ```typescript
  const rtcConfig = {
    iceServers: [
      {
        urls: 'turn:turn.aegislink.app:3478',
        username: 'anonymous-user',
        credential: 'ephemeral-password-token',
      }
    ],
    iceTransportPolicy: 'relay' // Forzar tráfico únicamente por TURN si se desea anonimato absoluto
  };
  ```

---

## 2. Protocolo de Señalización Cifrado
Los mensajes de señalización (Offer, Answer, Candidatos ICE) contienen detalles técnicos que no deben ser legibles por el servidor de señalización (Relay Socket.IO).

### Flujo de Señalización E2EE
1. El iniciador genera la oferta SDP (Offer).
2. Cifra el SDP utilizando la clave simétrica derivada mediante Double Ratchet (o un canal temporal seguro cifrado).
3. Envía el sobre cifrado al destinatario a través de Socket.IO.
4. El destinatario descifra el SDP, genera la respuesta SDP (Answer), la cifra y la envía de vuelta.
5. Los candidatos ICE se cifran individualmente de la misma manera antes de ser transmitidos.

---

## 3. WebRTC Nativo en React Native (`react-native-webrtc`)
AegisLink utiliza la implementación nativa mediante el plugin de configuración de Expo para asegurar compatibilidad total en plataformas Android e iOS con la arquitectura moderna.
