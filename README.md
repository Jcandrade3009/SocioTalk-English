# SocioTalk English

Prototipo móvil PWA para practicar inglés por voz. Incluye escenarios, voz del tutor, reconocimiento de voz cuando el navegador lo permite, correcciones de demostración, progreso local e instalación en pantalla de inicio.

## Probar localmente

Debido al service worker, conviene servirlo por HTTP:

```bash
python3 -m http.server 8080
```

Abre `http://localhost:8080` desde la carpeta del proyecto.

## Publicar con GitHub Pages

1. Crea un repositorio, por ejemplo `sociotalk-english`.
2. Sube el contenido de esta carpeta a la rama `main`.
3. En GitHub: Settings → Pages → Deploy from a branch → `main` / root.
4. Abre la URL HTTPS que GitHub genera.
5. En Android/Chrome usa "Instalar app" o "Agregar a pantalla principal".

## Importante sobre la IA

Esta versión no contiene claves API y por eso puede publicarse de forma segura en GitHub Pages. Las correcciones incluidas son de demostración/locales.

Para convertirla en un tutor con IA real (corrección profunda, conversación dinámica, pronunciación, historial y perfiles) hay que añadir un backend seguro. Nunca se debe poner una clave privada de API directamente en JavaScript público.
