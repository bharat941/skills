'use strict';
// Java sources for the custom process steps of the asset workflow fixture project (fixtures/asset-workflow.js).
// Kept apart from that project so the recorded wf-migrator output stays a byte-for-byte recording.
const fs = require('fs');
const path = require('path');

const PKG = 'core/src/main/java/com/example/wfmin/core';

const JAVA_FILES = {
  // Rendition writer: Layer + addRendition, registered by class name.
  [`${PKG}/workflow/WatermarkProcess.java`]: `package com.example.wfmin.core.workflow;

import com.adobe.granite.workflow.WorkflowSession;
import com.adobe.granite.workflow.exec.WorkItem;
import com.adobe.granite.workflow.exec.WorkflowProcess;
import com.adobe.granite.workflow.metadata.MetaDataMap;
import com.day.cq.dam.api.Asset;
import com.day.image.Layer;
import org.osgi.service.component.annotations.Component;

@Component(service = WorkflowProcess.class, property = { "process.label=Watermark renditions" })
public class WatermarkProcess implements WorkflowProcess {
    @Override
    public void execute(WorkItem item, WorkflowSession session, MetaDataMap args) {
        Asset asset = item.getWorkflowData().getPayload() == null ? null : null;
        Layer layer = new Layer(asset.getOriginal().getStream());
        asset.addRendition("cq5dam.watermark.png", layer.getImage(), "image/png");
    }
}
`,
  // Plain post-processing: tags the asset. Only a comment mentions a shell call.
  [`${PKG}/workflow/TagByFolderProcess.java`]: `package com.example.wfmin.core.workflow;

import com.adobe.granite.workflow.WorkflowSession;
import com.adobe.granite.workflow.exec.WorkItem;
import com.adobe.granite.workflow.exec.WorkflowProcess;
import com.adobe.granite.workflow.metadata.MetaDataMap;
import com.example.wfmin.core.util.FolderTags;
import org.osgi.service.component.annotations.Component;

/* Used to call Runtime.getRuntime().exec("exiftool") here; removed in 2021. */
@Component(service = WorkflowProcess.class, property = { "process.label=Tag by folder" })
public class TagByFolderProcess implements WorkflowProcess {
    @Override
    public void execute(WorkItem item, WorkflowSession session, MetaDataMap args) {
        // new ProcessBuilder("exiftool") was here too
        FolderTags.apply(item.getWorkflowData().getPayload().toString(), session);
    }
}
`,
  [`${PKG}/util/FolderTags.java`]: `package com.example.wfmin.core.util;

public final class FolderTags {
    private FolderTags() {}
    public static void apply(String path, Object session) {}
}
`,
  // Replicates the asset with the legacy Replicator API and SCR annotations.
  [`${PKG}/workflow/AutoPublishProcess.java`]: `package com.example.wfmin.core.workflow;

import com.adobe.granite.workflow.WorkflowSession;
import com.adobe.granite.workflow.exec.WorkItem;
import com.adobe.granite.workflow.exec.WorkflowProcess;
import com.adobe.granite.workflow.metadata.MetaDataMap;
import com.day.cq.replication.ReplicationActionType;
import com.day.cq.replication.Replicator;
import org.apache.felix.scr.annotations.Component;
import org.apache.felix.scr.annotations.Property;
import org.apache.felix.scr.annotations.Reference;
import org.apache.felix.scr.annotations.Service;

@Component
@Service
@Property(name = "process.label", value = "Auto publish")
public class AutoPublishProcess implements WorkflowProcess {
    @Reference
    private Replicator replicator;

    @Override
    public void execute(WorkItem item, WorkflowSession session, MetaDataMap args) throws Exception {
        replicator.replicate(null, ReplicationActionType.ACTIVATE, item.getWorkflowData().getPayload().toString());
    }
}
`,
};

function writeJavaSources(projectRoot, files = JAVA_FILES) {
  for (const [rel, text] of Object.entries(files)) {
    const f = path.join(projectRoot, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  return projectRoot;
}

module.exports = { JAVA_FILES, writeJavaSources };
