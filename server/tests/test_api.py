"""
Integration tests for the FastAPI server routes.

The TestClient fixture and shared test data are provided by conftest.py.
Each test starts with an empty database (enforced by the autouse clean_db fixture).
"""

from tests.conftest import (
    AUTH_HEADERS,
    GEOJSON_BYTES,
    STATIC_CSV_BYTES,
    TIMESERIES_CSV_BYTES,
)

# ── Auth ─────────────────────────────────────────────────────────────────────


class TestAuth:
    def test_missing_api_key_returns_401(self, client):
        assert client.get("/api/geometry").status_code == 401

    def test_wrong_api_key_returns_401(self, client):
        r = client.get("/api/geometry", headers={"X-MyApp-ApiKey": "bad-key"})
        assert r.status_code == 401

    def test_valid_api_key_returns_200(self, client):
        assert client.get("/api/geometry", headers=AUTH_HEADERS).status_code == 200


# ── Geometry ──────────────────────────────────────────────────────────────────


class TestGeometry:
    def _upload(self, client, *, name="test-geo", geojson=None):
        return client.post(
            "/api/geometry",
            headers=AUTH_HEADERS,
            files={"file": ("test.geojson", geojson or GEOJSON_BYTES, "application/geo+json")},
            data={"name": name, "format": "geojson"},
        )

    def test_upload_returns_201(self, client):
        assert self._upload(client).status_code == 201

    def test_upload_response_fields(self, client):
        body = self._upload(client).json()
        assert body["name"] == "test-geo"
        assert body["format"] == "geojson"
        assert "id" in body
        assert "file_id" in body

    def test_upload_auto_detects_join_key(self, client):
        # GEOJSON_BYTES has a feature property named "id"
        body = self._upload(client).json()
        assert body["join_key"] == "id"

    def test_list_empty_initially(self, client):
        assert client.get("/api/geometry", headers=AUTH_HEADERS).json() == []

    def test_list_includes_uploaded_files(self, client):
        self._upload(client, name="geo-a")
        self._upload(client, name="geo-b")
        names = {g["name"] for g in client.get("/api/geometry", headers=AUTH_HEADERS).json()}
        assert {"geo-a", "geo-b"}.issubset(names)

    def test_get_data_returns_feature_collection(self, client):
        geo_id = self._upload(client).json()["id"]
        r = client.get(f"/api/geometry/{geo_id}/data", headers=AUTH_HEADERS)
        assert r.status_code == 200
        assert r.json()["type"] == "FeatureCollection"

    def test_get_data_404_for_unknown_id(self, client):
        assert client.get("/api/geometry/99999/data", headers=AUTH_HEADERS).status_code == 404

    def test_get_schema_returns_properties_and_suggestion(self, client):
        geo_id = self._upload(client).json()["id"]
        schema = client.get(f"/api/geometry/{geo_id}/schema", headers=AUTH_HEADERS).json()
        assert "id" in schema["properties"]
        assert "name" in schema["properties"]
        assert schema["suggested_join_key"] == "id"

    def test_duplicate_upload_shares_content_hash(self, client):
        """Uploading the same bytes twice should hit the dedup path and return the same file_id."""
        r1 = self._upload(client, name="geo-1")
        r2 = self._upload(client, name="geo-2")
        assert r1.json()["file_id"] == r2.json()["file_id"]
        # But they are distinct DB records with different ids
        assert r1.json()["id"] != r2.json()["id"]


# ── Datasets ──────────────────────────────────────────────────────────────────


class TestDatasets:
    def _upload_static(self, client, *, name="static-ds"):
        return client.post(
            "/api/datasets",
            headers=AUTH_HEADERS,
            files={"file": ("data.csv", STATIC_CSV_BYTES, "text/csv")},
            data={"name": name, "format": "csv"},
        )

    def _upload_timeseries(self, client, *, name="ts-ds"):
        return client.post(
            "/api/datasets",
            headers=AUTH_HEADERS,
            files={"file": ("ts.csv", TIMESERIES_CSV_BYTES, "text/csv")},
            data={"name": name, "format": "csv"},
        )

    def test_upload_static_returns_201(self, client):
        assert self._upload_static(client).status_code == 201

    def test_upload_static_has_no_timestamp_col(self, client):
        assert self._upload_static(client).json()["timestamp_col"] is None

    def test_upload_timeseries_detects_timestamp_col(self, client):
        body = self._upload_timeseries(client).json()
        assert body["timestamp_col"] == "datetime"

    def test_list_empty_initially(self, client):
        assert client.get("/api/datasets", headers=AUTH_HEADERS).json() == []

    def test_list_includes_uploaded_datasets(self, client):
        self._upload_static(client, name="ds-a")
        self._upload_timeseries(client, name="ds-b")
        names = {d["name"] for d in client.get("/api/datasets", headers=AUTH_HEADERS).json()}
        assert {"ds-a", "ds-b"}.issubset(names)

    def test_get_columns_lists_all_columns(self, client):
        ds_id = self._upload_static(client).json()["id"]
        schema = client.get(f"/api/datasets/{ds_id}/columns", headers=AUTH_HEADERS).json()
        assert set(schema["columns"]) == {"id", "value"}

    def test_get_columns_suggests_join_key(self, client):
        ds_id = self._upload_static(client).json()["id"]
        schema = client.get(f"/api/datasets/{ds_id}/columns", headers=AUTH_HEADERS).json()
        assert schema["suggested_join_key"] == "id"

    def test_get_columns_404_for_unknown_id(self, client):
        assert client.get("/api/datasets/99999/columns", headers=AUTH_HEADERS).status_code == 404

    def test_timeseries_partitions_written_on_upload(self, client):
        ds_id = self._upload_timeseries(client).json()["id"]
        r = client.get(f"/api/datasets/{ds_id}/partitions", headers=AUTH_HEADERS)
        assert r.status_code == 200
        p = r.json()
        assert "2024-01-01" in p["dates"]
        assert "2024-01-02" in p["dates"]
        assert p["timestamp_col"] == "datetime"

    def test_static_dataset_partitions_returns_400(self, client):
        ds_id = self._upload_static(client).json()["id"]
        r = client.get(f"/api/datasets/{ds_id}/partitions", headers=AUTH_HEADERS)
        assert r.status_code == 400


# ── Layers ────────────────────────────────────────────────────────────────────


class TestLayers:
    PROJECT  = "test-project"
    SCENARIO = "test-scenario"

    # ── helpers ──────────────────────────────────────────────────────────────

    def _upload_geo(self, client):
        return client.post(
            "/api/geometry",
            headers=AUTH_HEADERS,
            files={"file": ("geo.geojson", GEOJSON_BYTES, "application/geo+json")},
            data={"format": "geojson"},
        ).json()["id"]

    def _upload_ds(self, client):
        return client.post(
            "/api/datasets",
            headers=AUTH_HEADERS,
            files={"file": ("data.csv", STATIC_CSV_BYTES, "text/csv")},
            data={"format": "csv"},
        ).json()["id"]

    def _create_layer(self, client, geo_id, *, name="layer-1"):
        return client.post(
            "/api/layers",
            headers=AUTH_HEADERS,
            json={
                "project": self.PROJECT,
                "scenario": self.SCENARIO,
                "geometry_id": geo_id,
                "name": name,
                "deck_layer_type": "GeoJsonLayer",
            },
        )

    def _attach_dataset(self, client, layer_id, ds_id):
        return client.post(
            f"/api/layers/{layer_id}/datasets",
            headers=AUTH_HEADERS,
            json={"dataset_id": ds_id, "geom_join_key": "id", "data_join_key": "id"},
        )

    def _add_style(self, client, layer_id, ld_id):
        return client.post(
            f"/api/layers/{layer_id}/style",
            headers=AUTH_HEADERS,
            json={
                "layer_dataset_id": ld_id,
                "visual_property": "getFillColor",
                "column": "value",
                "colormap": "viridis",
                "scale_type": "linear",
                "domain_min": 0,
                "domain_max": 500,
            },
        )

    # ── layer creation ───────────────────────────────────────────────────────

    def test_create_layer_returns_201(self, client):
        geo_id = self._upload_geo(client)
        assert self._create_layer(client, geo_id).status_code == 201

    def test_create_layer_response_fields(self, client):
        geo_id = self._upload_geo(client)
        body = self._create_layer(client, geo_id).json()
        assert body["name"] == "layer-1"
        assert body["deck_layer_type"] == "GeoJsonLayer"
        assert "id" in body

    def test_get_layers_empty_for_unknown_scenario(self, client):
        r = client.get("/api/layers/no-proj/no-scen", headers=AUTH_HEADERS)
        assert r.status_code == 200
        assert r.json() == []

    def test_get_layers_returns_created_layer(self, client):
        geo_id = self._upload_geo(client)
        self._create_layer(client, geo_id, name="my-layer")
        layers = client.get(
            f"/api/layers/{self.PROJECT}/{self.SCENARIO}", headers=AUTH_HEADERS
        ).json()
        assert len(layers) == 1
        assert layers[0]["name"] == "my-layer"
        assert layers[0]["geometry"] is not None

    def test_get_layers_embeds_geometry(self, client):
        geo_id = self._upload_geo(client)
        self._create_layer(client, geo_id)
        layer = client.get(
            f"/api/layers/{self.PROJECT}/{self.SCENARIO}", headers=AUTH_HEADERS
        ).json()[0]
        assert layer["geometry"]["id"] == geo_id
        assert layer["geometry"]["format"] == "geojson"

    # ── attach dataset ───────────────────────────────────────────────────────

    def test_attach_dataset_returns_201(self, client):
        geo_id   = self._upload_geo(client)
        ds_id    = self._upload_ds(client)
        layer_id = self._create_layer(client, geo_id).json()["id"]
        assert self._attach_dataset(client, layer_id, ds_id).status_code == 201

    def test_get_layers_includes_attached_dataset(self, client):
        geo_id   = self._upload_geo(client)
        ds_id    = self._upload_ds(client)
        layer_id = self._create_layer(client, geo_id).json()["id"]
        self._attach_dataset(client, layer_id, ds_id)
        layer = client.get(
            f"/api/layers/{self.PROJECT}/{self.SCENARIO}", headers=AUTH_HEADERS
        ).json()[0]
        assert len(layer["layer_datasets"]) == 1
        assert layer["layer_datasets"][0]["dataset"]["id"] == ds_id

    # ── style mappings ───────────────────────────────────────────────────────

    def test_add_style_mapping_returns_201(self, client):
        geo_id   = self._upload_geo(client)
        ds_id    = self._upload_ds(client)
        layer_id = self._create_layer(client, geo_id).json()["id"]
        ld_id    = self._attach_dataset(client, layer_id, ds_id).json()["id"]
        assert self._add_style(client, layer_id, ld_id).status_code == 201

    def test_get_layers_includes_style_mappings(self, client):
        geo_id   = self._upload_geo(client)
        ds_id    = self._upload_ds(client)
        layer_id = self._create_layer(client, geo_id).json()["id"]
        ld_id    = self._attach_dataset(client, layer_id, ds_id).json()["id"]
        self._add_style(client, layer_id, ld_id)
        layer = client.get(
            f"/api/layers/{self.PROJECT}/{self.SCENARIO}", headers=AUTH_HEADERS
        ).json()[0]
        assert len(layer["style_mappings"]) == 1
        sm = layer["style_mappings"][0]
        assert sm["visual_property"] == "getFillColor"
        assert sm["colormap"] == "viridis"
        assert sm["domain_min"] == 0.0
        assert sm["domain_max"] == 500.0

    def test_delete_style_mapping_returns_ok(self, client):
        geo_id   = self._upload_geo(client)
        ds_id    = self._upload_ds(client)
        layer_id = self._create_layer(client, geo_id).json()["id"]
        ld_id    = self._attach_dataset(client, layer_id, ds_id).json()["id"]
        sm_id    = self._add_style(client, layer_id, ld_id).json()["id"]
        r = client.delete(f"/api/layers/{layer_id}/style/{sm_id}", headers=AUTH_HEADERS)
        assert r.status_code == 200
        assert r.json()["ok"] is True

    def test_delete_style_mapping_removes_it_from_layer(self, client):
        geo_id   = self._upload_geo(client)
        ds_id    = self._upload_ds(client)
        layer_id = self._create_layer(client, geo_id).json()["id"]
        ld_id    = self._attach_dataset(client, layer_id, ds_id).json()["id"]
        sm_id    = self._add_style(client, layer_id, ld_id).json()["id"]
        client.delete(f"/api/layers/{layer_id}/style/{sm_id}", headers=AUTH_HEADERS)
        layer = client.get(
            f"/api/layers/{self.PROJECT}/{self.SCENARIO}", headers=AUTH_HEADERS
        ).json()[0]
        assert layer["style_mappings"] == []

    def test_delete_style_mapping_404_for_unknown(self, client):
        geo_id   = self._upload_geo(client)
        layer_id = self._create_layer(client, geo_id).json()["id"]
        r = client.delete(f"/api/layers/{layer_id}/style/99999", headers=AUTH_HEADERS)
        assert r.status_code == 404


# ── Integration: full layer creation flow ────────────────────────────────────


class TestFullFlow:
    PROJECT  = "flow-project"
    SCENARIO = "flow-scenario"

    def test_geometry_dataset_layer_style_end_to_end(self, client):
        # 1. Upload geometry
        geo = client.post(
            "/api/geometry",
            headers=AUTH_HEADERS,
            files={"file": ("geo.geojson", GEOJSON_BYTES, "application/geo+json")},
            data={"format": "geojson"},
        ).json()
        assert geo["join_key"] == "id"

        # 2. Upload dataset
        ds = client.post(
            "/api/datasets",
            headers=AUTH_HEADERS,
            files={"file": ("data.csv", STATIC_CSV_BYTES, "text/csv")},
            data={"format": "csv"},
        ).json()
        assert ds["timestamp_col"] is None

        # 3. Create layer
        layer = client.post(
            "/api/layers",
            headers=AUTH_HEADERS,
            json={
                "project": self.PROJECT,
                "scenario": self.SCENARIO,
                "geometry_id": geo["id"],
                "name": "e2e-layer",
                "deck_layer_type": "GeoJsonLayer",
            },
        ).json()

        # 4. Attach dataset with join keys
        ld = client.post(
            f"/api/layers/{layer['id']}/datasets",
            headers=AUTH_HEADERS,
            json={"dataset_id": ds["id"], "geom_join_key": "id", "data_join_key": "id"},
        ).json()

        # 5. Add style mapping
        client.post(
            f"/api/layers/{layer['id']}/style",
            headers=AUTH_HEADERS,
            json={
                "layer_dataset_id": ld["id"],
                "visual_property": "getFillColor",
                "column": "value",
                "colormap": "plasma",
                "scale_type": "linear",
                "domain_min": 0,
                "domain_max": 300,
            },
        )

        # 6. Fetch the full layer config and verify everything is wired up
        layers = client.get(
            f"/api/layers/{self.PROJECT}/{self.SCENARIO}", headers=AUTH_HEADERS
        ).json()
        assert len(layers) == 1
        lyr = layers[0]
        assert lyr["name"] == "e2e-layer"
        assert lyr["geometry"]["id"] == geo["id"]
        assert len(lyr["layer_datasets"]) == 1
        assert lyr["layer_datasets"][0]["geom_join_key"] == "id"
        assert lyr["layer_datasets"][0]["data_join_key"] == "id"
        assert len(lyr["style_mappings"]) == 1
        sm = lyr["style_mappings"][0]
        assert sm["visual_property"] == "getFillColor"
        assert sm["colormap"] == "plasma"
        assert sm["domain_max"] == 300.0
