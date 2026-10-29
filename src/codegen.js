import * as eventToCode from './shared/eventToCode.js';
import { withDashboardFields } from './feed.js';

/** The same choices as the dashboard's Code export and the MCP generate_handler tool */
export const LANGUAGES = {
    typescript: {
        label: 'TypeScript', detail: 'Interfaces, JSON fixture and a Jest/Vitest test',
        types: eventToCode.generateTypeScript, typesFile: (type) => `${type}.ts`, typesLanguage: 'typescript',
        test: eventToCode.generateJsTest, testFile: (_type, slug) => `${slug}.test.js`, testLanguage: 'javascript'
    },
    python: {
        label: 'Python', detail: 'TypedDicts, JSON fixture and a pytest test',
        types: eventToCode.generatePythonTypes, typesFile: (_type, slug) => `${slug}.py`, typesLanguage: 'python',
        test: eventToCode.generatePytest, testFile: (_type, slug) => `test_${slug}.py`, testLanguage: 'python'
    },
    php: {
        label: 'PHP', detail: 'Readonly DTO classes, JSON fixture and a Laravel/PHPUnit test',
        types: eventToCode.generatePhpDto, typesFile: (type) => `${type}.php`, typesLanguage: 'php',
        test: eventToCode.generateLaravelTest, testFile: (type) => `${type}WebhookTest.php`, testLanguage: 'php'
    },
    go: {
        label: 'Go', detail: 'Structs and a JSON fixture',
        types: eventToCode.generateGoStructs, typesFile: (_type, slug) => `${slug}.go`, typesLanguage: 'go',
        test: null
    }
};

/**
 * Types, fixture and test for one event, as files to open.
 *
 * @param {object} log        A full log row from /api/logs/:id
 * @param {string} language   A key of LANGUAGES
 * @param {string} targetUrl  Where the test posts the event
 * @returns {{files: {name: string, language: string, content: string}[], notes: string[]}}
 */
export function generateFiles(log, language, targetUrl) {
    const lang = LANGUAGES[language];
    if (!lang) throw new Error(`Unknown language ${language}`);
    if (Number(log.is_truncated) === 1) {
        throw new Error(`Event #${log.number} was larger than the capture limit and only its start was stored, so its shape can't be read reliably. Pick a complete event of the same type.`);
    }

    const source = withDashboardFields(log);
    const name = eventToCode.eventName(source);
    const typeName = eventToCode.pascalCase(name);
    const slug = name.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').toLowerCase() || 'webhook';

    const files = [];
    const notes = [];
    try {
        files.push({ name: lang.typesFile(typeName, slug), language: lang.typesLanguage, content: lang.types(source) });
    } catch (err) {
        notes.push(`No types: ${err.message}`);
    }

    const fixtureName = eventToCode.fixtureFileName(source);
    files.push({ name: fixtureName, language: fixtureName.endsWith('.json') ? 'json' : fixtureName.endsWith('.xml') ? 'xml' : 'plaintext', content: eventToCode.generateFixture(source) });

    if (lang.test) {
        files.push({ name: lang.testFile(typeName, slug), language: lang.testLanguage, content: lang.test(source, targetUrl) });
    } else {
        notes.push('No test generator for Go yet; post the fixture to your handler with net/http/httptest.');
    }

    return { files, notes };
}

/** The body as a fixture: pretty JSON when it parses, the raw text otherwise */
export function fixtureFor(log) {
    return eventToCode.generateFixture(withDashboardFields(log));
}
