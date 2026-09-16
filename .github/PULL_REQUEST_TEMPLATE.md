## Qué cambia

<!-- Una o dos frases. Qué y por qué. -->

## Docs

<!-- OBLIGATORIO (regla de oro "La doc no miente" #7, gate `docs-sync` en CI).
     Deja UNA de las dos líneas, sin el comentario:
       Docs: docs/PROTOCOL.md, docs/ROADMAP.md
       Docs: none — <por qué no aplica: p. ej. "solo tests", "refactor sin cambio de comportamiento">
     Mapa código → doc canónico: CLAUDE.md, sección "La doc no miente". -->
Docs:

## Verificación

<!-- Qué se corrió y qué salió: tsc, suites concretas, prueba manual en dispositivo/relay. -->

## Checklist

- [ ] Un test por fix de seguridad (regla de oro de seguridad #11)
- [ ] Paridad mobile ↔ desktop si toca crypto/sesión/ratchet (#5)
- [ ] Sin `console.log`, sin `any`, sin material de clave en logs ni en el wire
- [ ] Sin atribución de IA en commits ni en este cuerpo
