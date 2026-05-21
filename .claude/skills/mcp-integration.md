---
name: mcp-integration
description: Guía de uso de Model Context Protocol (MCP) y herramientas locales para los agentes de AegisLink.
---

# Integración MCP y Skills Avanzados para Agentes

Esta skill define cómo los agentes de AegisLink deben aprovechar sus herramientas MCP e integraciones de sistema para maximizar su autonomía sin violar los principios de privacidad del proyecto.

## 1. Filesystem (Sistema de Archivos)
- **Uso Crítico**: Siempre usar herramientas de sistema para leer (`view_file`), modificar (`replace_file_content`) y buscar (`grep_search`) en lugar de pedirle al usuario que copie/pegue código.
- **Regla de AegisLink**: Nunca guardar logs ni volcados de base de datos del usuario en archivos temporales que persistan. Toda clave de prueba debe ser destruida.

## 2. Ejecución de Comandos (Bash/Terminal)
- **Compilación y Testing**: Antes de dar por finalizada una tarea, el agente DEBE ejecutar `npx tsc --noEmit` en la carpeta correspondiente (`mobile/` o `server/`) usando comandos de terminal para verificar tipos.
- **Auditoría**: Los agentes QA deben ejecutar de forma autónoma los comandos de grep para buscar fugas de claves o `console.log` en producción.

## 3. Búsqueda Web e Investigación
- Si encuentras un error desconocido en Expo SDK 54 o TweetNaCl, utiliza búsqueda web (`search_web`) para consultar la documentación oficial antes de adivinar parámetros o usar sintaxis desactualizada (ej. usar legacy fs).

## 4. Orquestación y Concurrencia
- **Director**: Usa las capacidades de subagentes para lanzar tareas en paralelo solo cuando no toquen el mismo archivo.
- No confíes ciegamente en la memoria de contexto: lee el archivo siempre antes de aplicar un reemplazo.
