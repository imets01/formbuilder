FROM python:3.12-slim

WORKDIR /app/backend

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt gunicorn

COPY . /app/backend/

# Saved forms. On an ephemeral host this is wiped on redeploy — mount a volume to keep them.
ENV FORMS_DIR=/app/forms
RUN mkdir -p /app/forms

EXPOSE 8080

CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "2", "--timeout", "120", "app:app"]
