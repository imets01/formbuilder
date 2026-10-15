"""
Thin Flask server.

Endpoints:
    GET  /                  health check
    GET  /api/heartbeat     health check (JSON)
    GET  /api/auth          whether this request may save/delete forms (demo mode)
    POST /api/generate-json builds and returns the form-structure JSON
    POST /api/import-excel  reads a specification workbook into a form payload
    POST /api/forms/<id>/export-xlsx  writes the workbook back out
    GET  /api/translate-suggest       phrase-library lookup
    POST /api/preview       renders the form and returns a token to view it
    GET  /preview           serves a rendered preview by token
"""

import hmac
import io
import math
import os
import uuid
from collections import OrderedDict

from flask import Flask, jsonify, request, send_file
from flask_cors import CORS

from excel_importer import import_spreadsheet
from spreadsheet_exporter import export_spreadsheet
from json_builder import build_form_json, safe_form_name
import dictionary
import forms_store
import stub_renderer

app = Flask(__name__)
CORS(app)

# Preserve insertion order in the JSON output (Flask 3.x API).
app.json.sort_keys = False

# Demo mode: when ADMIN_TOKEN is set (as on the public Vercel deployment), only requests
# carrying it in X-Admin-Token may change stored forms. Everyone else can still build,
# preview, import and export — just not save or delete. Unset (local dev) = no lock.
_WRITE_ENDPOINTS = {'put_form', 'remove_form', 'upload_form_source'}


def _admin_token() -> str:
    return os.environ.get('ADMIN_TOKEN', '')


def _can_write() -> bool:
    token = _admin_token()
    if not token:
        return True
    sent = request.headers.get('X-Admin-Token', '')
    return hmac.compare_digest(sent.encode(), token.encode())


@app.before_request
def _require_admin_for_writes():
    # CORS preflights (OPTIONS) map to the same endpoint but never carry the header.
    if request.method == 'OPTIONS':
        return None
    if request.endpoint in _WRITE_ENDPOINTS and not _can_write():
        return jsonify(status="error", message="read-only demo: saving is disabled"), 403


@app.route('/')
def home():
    return {"message": "Backend is running!"}


@app.route('/api/heartbeat')
def heartbeat():
    return jsonify(status="success", message="Server is running.")


@app.route('/api/auth')
def auth_status():
    """Tell the builder whether to autosave and offer delete for this visitor."""
    return jsonify(canWrite=_can_write(), demo=bool(_admin_token()))


@app.route('/api/forms', methods=['GET'])
def list_forms():
    """Return summaries of every saved form, newest first."""
    return jsonify(forms_store.list_forms())


@app.route('/api/forms/<form_id>', methods=['GET'])
def get_form(form_id):
    """Return one saved form by id, or 404 if it doesn't exist."""
    try:
        form = forms_store.load_form(form_id)
    except forms_store.InvalidFormId as exc:
        return jsonify(status="error", message=str(exc)), 400
    if form is None:
        return jsonify(status="error", message="form not found"), 404
    # Surface whether an imported-source spreadsheet is stored, so the builder can
    # offer the round-trip "Export spreadsheet" action only when it makes sense.
    form['hasSource'] = forms_store.has_source(form_id)
    return jsonify(form)


def _set_title(form: dict, title: str) -> None:
    """Set a form's name, keeping the payload copy the builder reads on load in step."""
    form['title'] = title
    payload = form.get('payload')
    if isinstance(payload, dict):
        payload['formTitle'] = title


@app.route('/api/forms/<form_id>', methods=['PUT'])
def put_form(form_id):
    """Create or overwrite a saved form. The id in the URL wins over the body's.

    No two forms may go by the same name.
    """
    form = request.json or {}
    form['id'] = form_id  # trust the URL, not a possibly-mismatched body id
    try:
        if forms_store.load_form(form_id) is None:  # a create, not an overwrite
            _set_title(form, forms_store.unique_title(form.get('title'), exclude_id=form_id))
        saved = forms_store.save_form(form)
    except forms_store.InvalidFormId as exc:
        return jsonify(status="error", message=str(exc)), 400
    except forms_store.DuplicateFormTitle as exc:
        return jsonify(status="error", message=str(exc), conflictId=exc.existing_id), 409
    return jsonify(saved)


@app.route('/api/forms/<form_id>', methods=['DELETE'])
def remove_form(form_id):
    """Delete a saved form. Idempotent: deleting a missing form still returns ok."""
    try:
        forms_store.delete_form(form_id)
    except forms_store.InvalidFormId as exc:
        return jsonify(status="error", message=str(exc)), 400
    return jsonify(status="success")


def _json_safe(value):
    """Replace NaN/Infinity (used as 'empty' sentinels in the build output) with None so the
    result is valid JSON. The browser's JSON.parse rejects bare NaN tokens; the pipeline keeps
    the raw build_form_json output, so only this debug endpoint needs sanitizing."""
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_json_safe(v) for v in value]
    return value


@app.route('/api/generate-json', methods=['POST'])
def generate_json():
    """Return the form-structure JSON only. Useful for debugging / previewing the output shape."""
    payload = request.json or {}
    return jsonify(_json_safe(build_form_json(payload)))


@app.route('/api/import-excel', methods=['POST'])
def import_excel():
    """Parse a legacy PSPH .xlsx/.csv into a builder payload the frontend can load."""
    file = request.files.get('file')
    if file is None or not file.filename:
        return jsonify(status="error", message="No file uploaded."), 400
    try:
        payload = import_spreadsheet(file.read(), file.filename)
    except Exception as exc:
        return jsonify(status="error", message=str(exc)), 400
    return jsonify(status="success", payload=payload)


@app.route('/api/forms/<form_id>/source', methods=['POST'])
def upload_form_source(form_id):
    """Store the original imported spreadsheet alongside a form, for later round-trip export."""
    file = request.files.get('file')
    if file is None or not file.filename:
        return jsonify(status="error", message="No file uploaded."), 400
    try:
        forms_store.save_source(form_id, file.read())
    except forms_store.InvalidFormId as exc:
        return jsonify(status="error", message=str(exc)), 400
    return jsonify(status="success")


@app.route('/api/forms/<form_id>/export-xlsx', methods=['POST'])
def export_form_xlsx(form_id):
    """Return the form as a PSPH .xlsx.

    Body: { payload: <builder payload>, author, note, version }. If the form was imported, the
    edits are overlaid onto the stored original workbook; otherwise a fresh workbook is generated.
    """
    body = request.json or {}
    author = (body.get('author') or '').strip()
    note = (body.get('note') or '').strip()
    if not author or not note:
        return jsonify(status="error", message="Author and change note are required."), 400
    try:
        source = forms_store.load_source(form_id)
    except forms_store.InvalidFormId as exc:
        return jsonify(status="error", message=str(exc)), 400
    # No stored source → the form was built from scratch; generate a fresh PSPH workbook.
    try:
        data = export_spreadsheet(
            source,
            body.get('payload') or {},
            author=author,
            note=note,
            version=body.get('version', ''),
        )
        # Persist the result as the form's living spec, so the next export bumps the version
        # (and already-added fields are matched in place rather than re-inserted).
        forms_store.save_source(form_id, data)
    except Exception as exc:
        return jsonify(status="error", message=f"Export failed: {exc}"), 500
    return send_file(
        io.BytesIO(data),
        as_attachment=True,
        download_name=f"{safe_form_name(body.get('filename') or 'form')}.xlsx",
        mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )


@app.route('/api/translate-suggest', methods=['GET'])
def translate_suggest():
    """Suggest DE/FR/IT/EN translations for a common term from the phrase dictionary.

    Used by the builder to auto-fill the other languages of a title. Best-effort: a non-matching
    or empty term returns {"matched": false}.
    """
    text = request.args.get('text', '')
    lang = request.args.get('lang', 'de')
    if not text.strip():
        return jsonify(matched=False)
    result = dictionary.lookup(text, lang)
    if not result:
        return jsonify(matched=False)
    return jsonify(matched=True, name=result['name'], translations=result['translations'])


# In-memory store of recently built previews: token -> {language: HTML document}.
_PREVIEW_CACHE_SIZE = 20
_previews: "OrderedDict[str, dict[str, str]]" = OrderedDict()


@app.route('/api/preview', methods=['POST'])
def api_preview():
    """Render the form in every language; return a token to view it."""
    payload = request.json or {}
    language = request.args.get('lang', 'en').lower()
    token = uuid.uuid4().hex
    try:
        documents = stub_renderer.render_all(payload, token)
    except Exception as exc:
        import traceback; traceback.print_exc()
        return jsonify(status="error", message=str(exc)), 500
    _previews[token] = documents
    while len(_previews) > _PREVIEW_CACHE_SIZE:
        _previews.popitem(last=False)
    # Tell the caller which language to open first (fall back to whatever built).
    initial = language if language in documents else next(iter(documents))
    return jsonify(status="success", id=token, lang=initial)


@app.route('/preview')
def preview_page():
    """Serve a previously rendered preview as a real page."""
    documents = _previews.get(request.args.get('id', ''))
    if documents is None:
        return "Preview not found or expired.", 404
    language = request.args.get('lang', '').lower()
    html = documents.get(language) or next(iter(documents.values()))
    return html, 200, {'Content-Type': 'text/html; charset=utf-8'}


if __name__ == "__main__":
    app.run(debug=True, port=5000)
