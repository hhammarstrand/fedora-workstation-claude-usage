/* Registrerar loader-hookarna. Används som `node --import ./tests/js/register.mjs`. */
import {register} from 'node:module';
import {pathToFileURL} from 'node:url';

register('./loader.mjs', pathToFileURL(import.meta.filename));
