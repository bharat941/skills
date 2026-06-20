# `java.io.InputStream` usage on AEM as a Cloud Service

BPA pattern id: **`inputStreamUsage`**.

Covers BPA findings flagged on Java code that passes `java.io.InputStream` to AEM/JCR/DAM APIs in ways that are deprecated, unsupported, or unsafe on AEM as a Cloud Service. This is the largest single advisory finding type in the **Repository & Code Structure** wall (~4,761 findings across the reference customer set).

**Before transformation steps:** [aem-cloud-service-pattern-prerequisites.md](aem-cloud-service-pattern-prerequisites.md) (SCR → OSGi DS, service-user resolvers, SLF4J).

---

## Why `InputStream` is flagged on AEM as a Cloud Service

`InputStream` itself is a standard JDK type and is not banned. What BPA flags are **specific call sites** where passing an `InputStream` causes one or more of these problems on AEM as a Cloud Service:

1. **Deprecated overload** — the receiving API has an `InputStream` overload that's been superseded by a `Binary`-based or `Path`-based variant. Example: `javax.jcr.Property.setValue(InputStream)` → use `ValueFactory.createBinary(InputStream)` then `setValue(Binary)`.
2. **Resource leak risk** — callers that read uploads or repository binaries without `try-with-resources` leave file handles open. AEM as a Cloud Service runs in tighter, ephemeral containers where leaked handles trip pod recycling much faster than 6.x.
3. **In-memory buffering of large binaries** — code that reads the full stream into a `byte[]` exhausts per-pod heap. CS heap is bounded; the legacy "read it all into memory" pattern is no longer safe.
4. **Synchronous binary I/O on the request thread** — long-running stream copies block Sling request threads. CS request budgets are stricter; binary work belongs in Sling Jobs or Asset Compute.
5. **Custom Asset upload pipelines** — code that builds DAM assets by streaming bytes into `AssetManager` bypasses the Cloud Service binary-upload pipeline (chunked direct-to-storage uploads). Use the supported upload APIs or let Asset Compute do the work.

> **Subtype string note:** the BPA CSV column `subtype` carries `java.io.inputstream` for these findings (best-practices/migration scripts wire to that exact string). If your BPA report uses a different subtype, update [`bpa-local-parser.js`](../../migration/scripts/bpa-local-parser.js) and [`unified-collection-reader.js`](../../migration/scripts/unified-collection-reader.js) accordingly.

---

## Decision table — which API for which usage

| You see this on a flagged line | Replace with |
|---|---|
| `Property.setValue(InputStream)` | `ValueFactory.createBinary(InputStream)` → `Property.setValue(Binary)` |
| `Node.setProperty(name, InputStream)` | Same — wrap with `Binary`, set as `Binary` value |
| `assetManager.createAsset(path, InputStream, mimeType, autoSave)` reading from request | Prefer the **Cloud Service binary-upload pipeline** (chunked direct-to-storage) via the supported Assets HTTP API; if internal Java code must call `createAsset`, ensure the `InputStream` comes from a managed source and is closed in `try-with-resources` |
| `Asset.addRendition(name, InputStream, mimeType)` | Use `Asset.addRendition(name, InputStream, Map<String,Object>)` from a managed stream, or generate the rendition via Asset Compute and write the result through the supported API |
| Reading a JCR binary via `Property.getStream()` | `Property.getBinary().getStream()` inside `try-with-resources`; close both the `Binary` and the stream |
| `IOUtils.toByteArray(inputStream)` on a request-uploaded file | Stream directly to the destination; never buffer the whole file in memory |
| Custom servlet reading `RequestParameter.getInputStream()` then writing JCR | Move the write into a Sling **Job**; the request thread should only enqueue work |

---

## Classification

1. **JCR write path** — the flagged code calls `Property.setValue(InputStream)` / `Node.setProperty(name, InputStream)` → **apply step I1** (Binary wrap).
2. **JCR read path** — the flagged code calls `Property.getStream()` directly → **apply step I2** (Binary read + try-with-resources).
3. **DAM write path** — the flagged code calls `AssetManager.createAsset(..., InputStream, ...)` or `Asset.addRendition(..., InputStream, ...)` from a user-request handler → **apply steps I3 + I4** (manage the stream lifecycle, offload to a Sling Job).
4. **In-memory buffering** — `IOUtils.toByteArray`, `new byte[stream.available()]`, or any "read all into memory" idiom on a request-derived stream → **apply step I5** (stream-through, never buffer in full).
5. **Other / ambiguous** — surface the finding to the user with the file path and one-line context; do not auto-rewrite without confirming the destination API.

If multiple subtypes apply on the same file (e.g. a servlet that reads from a stream *and* writes to JCR), apply both steps in order.

---

## Transformation steps

### I1 — JCR write: wrap `InputStream` as `Binary`

```java
// BEFORE
node.setProperty("data", inputStream);

// AFTER
try (InputStream is = inputStream) {
    Binary binary = node.getSession().getValueFactory().createBinary(is);
    try {
        node.setProperty("data", binary);
    } finally {
        binary.dispose();
    }
}
```

Rules:
- Always close the source `InputStream` (`try-with-resources` if you own it).
- Always call `binary.dispose()` after the property is set — `Binary` may hold a temporary file in the Oak blob store.
- Do **not** keep the `Binary` reference past the dispose call.

### I2 — JCR read: open `Binary` explicitly and dispose it

```java
// BEFORE
InputStream is = property.getStream();
// ... read ... (often: never closed)

// AFTER
Binary binary = property.getBinary();
try (InputStream is = binary.getStream()) {
    // read
} finally {
    binary.dispose();
}
```

`property.getStream()` is deprecated. The `Binary` form is the supported replacement and the only one that lets you dispose the underlying handle deterministically.

### I3 — DAM write: manage the stream lifecycle

```java
// BEFORE
assetManager.createAsset(path, request.getInputStream(), mimeType, true);

// AFTER
try (InputStream is = new BufferedInputStream(request.getInputStream())) {
    assetManager.createAsset(path, is, mimeType, true);
}
```

Rules:
- The `InputStream` **must** be wrapped in `try-with-resources`.
- Prefer **chunked direct-to-storage uploads** (Cloud Service binary upload API) over server-side `createAsset` whenever the upload originates from an end-user HTTP request — those calls are async and don't block a request thread.

### I4 — Offload long binary work to a Sling Job

Anything beyond a few KB shouldn't run on the request thread. Move it to a `JobConsumer`:

```java
// In the servlet — enqueue the job, do NOT process the binary inline
Map<String, Object> props = new HashMap<>();
props.put("temporaryBlobPath", stagedPath); // stage to a tmp JCR path or external blob first
props.put("targetPath", targetPath);
jobManager.addJob("com/example/assets/ingest", props);
```

```java
// In the JobConsumer — open the resolver, do the work
@Override
public JobResult process(final Job job) {
    final String stagedPath = job.getProperty("temporaryBlobPath", String.class);
    try (ResourceResolver resolver = resolverFactory.getServiceResourceResolver(
            Collections.singletonMap(ResourceResolverFactory.SUBSERVICE, "asset-ingest"))) {
        // create the asset here, with a managed stream
        return JobResult.OK;
    } catch (LoginException e) {
        LOG.error("No resolver for asset-ingest", e);
        return JobResult.FAILED;
    }
}
```

See [resource-change-listener.md](resource-change-listener.md) for the full `JobConsumer` + service-user + Repoinit setup. The pattern is identical here.

### I5 — Stream-through, do not buffer

```java
// BEFORE — OOM on large files
byte[] bytes = IOUtils.toByteArray(inputStream);
node.setProperty("data", new ByteArrayInputStream(bytes));

// AFTER — stream directly
try (InputStream is = inputStream) {
    Binary binary = node.getSession().getValueFactory().createBinary(is);
    try {
        node.setProperty("data", binary);
    } finally {
        binary.dispose();
    }
}
```

If the legacy code transforms the bytes mid-stream, use a `FilterInputStream` or a piped stream instead of a `byte[]` buffer.

---

## Validation checklist

- [ ] Every `InputStream` opened in changed code is in a `try-with-resources` block (or explicitly closed in a `finally`).
- [ ] `Property.setValue(InputStream)` / `Node.setProperty(..., InputStream)` no longer appear; `Binary` is used.
- [ ] Every `Binary` instance is `dispose()`d after use.
- [ ] No `IOUtils.toByteArray(...)` / full-buffer reads on request-derived streams.
- [ ] DAM ingest paths longer than a few KB run inside a `JobConsumer`, not on the request thread.
- [ ] `mvn clean install` passes; **aemanalyser** reports no new InputStream-related advisories.
- [ ] Manual test: upload a >100 MB file through the changed path and observe pod heap (`/system/console/memoryusage` locally, or container metrics on CS) — no spike beyond steady-state.

---

## Test generation

After applying the transformation steps, generate a JUnit 5 test class for the changed file. Follow these rules:

- Use **AemContext** (`com.adobe.cq.testing.junit5.AemContextExtension`) for JCR/Sling context.
- Mock `AssetManager`, `ValueFactory`, `Property`, and `Binary` with Mockito.
- One `@Test` method per transformation step applied (I1, I2, I3, I4, I5).
- Verify: no real `InputStream` leaks — assert `Binary.dispose()` is called via `Mockito.verify`.
- Verify: `Binary` is set on the property, not the raw stream.

### Test template — I1 (JCR write via Binary)

```java
import static org.mockito.Mockito.*;

import java.io.ByteArrayInputStream;
import java.io.InputStream;

import javax.jcr.Binary;
import javax.jcr.Node;
import javax.jcr.Session;
import javax.jcr.ValueFactory;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class AssetUploadServletTest {

    @Mock private Session session;
    @Mock private ValueFactory valueFactory;
    @Mock private Binary binary;
    @Mock private Node node;

    @BeforeEach
    void setUp() throws Exception {
        when(session.getValueFactory()).thenReturn(valueFactory);
        when(valueFactory.createBinary(any(InputStream.class))).thenReturn(binary);
        when(node.getSession()).thenReturn(session);
    }

    @Test
    void shouldWritePropertyViaBinaryNotInputStream() throws Exception {
        // arrange
        InputStream inputStream = new ByteArrayInputStream("test".getBytes());

        // act — call the migrated method under test
        // e.g. servlet.writeToNode(node, inputStream);

        // assert: Binary used, not raw InputStream
        verify(valueFactory).createBinary(any(InputStream.class));
        verify(node).setProperty(anyString(), eq(binary));
        // assert: Binary disposed after use
        verify(binary).dispose();
    }
}
```

### Test template — I3 (DAM write with try-with-resources)

```java
@Test
void shouldWrapInputStreamInTryWithResources() throws Exception {
    // arrange
    AssetManager assetManager = mock(AssetManager.class);
    InputStream inputStream = spy(new ByteArrayInputStream("content".getBytes()));

    // act — call the migrated upload method
    // e.g. servlet.uploadAsset(assetManager, "/content/dam/test.jpg", inputStream, "image/jpeg");

    // assert: assetManager.createAsset called with the stream
    verify(assetManager).createAsset(eq("/content/dam/test.jpg"), any(InputStream.class), eq("image/jpeg"), eq(true));
    // assert: stream is closed after the call (try-with-resources guarantees this)
    verify(inputStream).close();
}
```

**Naming convention:** test class lives next to the production class under `src/test/java/…` with suffix `Test`. One test class per production class changed.

---

## See also

- [asset-manager.md](asset-manager.md) — for `assetApi` pattern (deprecated AssetManager methods).
- [resource-change-listener.md](resource-change-listener.md) — `JobConsumer` setup pattern reused in step I4.
- [aem-cloud-service-pattern-prerequisites.md](aem-cloud-service-pattern-prerequisites.md) — SCR → DS, service-user resolvers, SLF4J.
- [`../SKILL.md`](../SKILL.md) — pattern index.
