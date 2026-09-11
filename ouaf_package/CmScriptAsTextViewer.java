package com.splwg.cm.domain.common;

import com.splwg.base.api.service.DataElement;
import com.splwg.base.domain.common.script.Script;
import com.splwg.base.domain.common.script.ScriptAsTextViewer;
import com.splwg.base.domain.common.script.ScriptDataArea;
import com.splwg.base.domain.common.script.ScriptDataArea_Id;
import com.splwg.base.domain.common.script.ScriptSchema;
import com.splwg.base.domain.common.script.Script_Id;
import com.splwg.shared.common.ApplicationError;


/**
 * @author Guru
 *
@QueryPage (program = CMSCRTEXTP, secured = false, service = CMSCRTEXTP, modules = {},
 *      body = @DataElement (contents = {@DataField (name = SCHEMA_DEFN) 
 *      , @DataField (name = CHAR_VAL) 
 *      , @DataField (name = SCR_CD)
 *      , @DataField (name = DA_NAME)
 *      , @DataField (name = SCHEMA_NAME) 
 *      , @DataField (name = EDIT_DATA_TEXT)}),
 *      actions = { "change"
 *            , "add"
 *            , "delete"
 *            , "read"},
 *      header = { @DataField (name = SCR_CD), @DataField (name = CHAR_VAL)},
 *      headerFields = { @DataField (name = SCR_CD), @DataField (name = CHAR_VAL)})
 */
public class CmScriptAsTextViewer extends CmScriptAsTextViewer_Gen {
	@Override
	protected void change(DataElement root) throws ApplicationError {
		String option = root.getString(STRUCTURE.CHAR_VAL);
		ScriptSchema schema = ScriptSchema.Factory.newInstance();
		Script_Id scrId = root.getRequiredId(STRUCTURE.SCR_CD, Script.class);
		ScriptAsTextViewer viewer = ScriptAsTextViewer.Factory.newInstance();
		
		if(option == null) option = "";
		if("x".equalsIgnoreCase(option.trim())) {
			String xml = schema.formatSchema(scrId).asXML();
			root.put(STRUCTURE.SCHEMA_DEFN, xml);
		}else if("s".equalsIgnoreCase(option.trim())) {
			String text = viewer.getText(scrId);
			root.put(STRUCTURE.EDIT_DATA_TEXT, text);
		}else if("d".equalsIgnoreCase(option.trim())) {
			String schemaName = root.getRequired(STRUCTURE.SCHEMA_NAME);
			String daName = root.getRequired(STRUCTURE.DA_NAME);
			ScriptDataArea_Id dataAreaId = new ScriptDataArea_Id(scrId, daName);
			ScriptDataArea dataArea = dataAreaId.getEntity();
			String schemaType = dataArea.fetchSchema().fetchIdSchemaType().trimmedValue();
			String xml = schema.formatDataAreaSchema(schemaName, schemaType, daName).asXML();
			root.put(STRUCTURE.SCHEMA_DEFN, xml);
		}else {
			String text = viewer.getText(scrId);
			String xml = schema.formatSchema(scrId).asXML();
			root.put(STRUCTURE.EDIT_DATA_TEXT, text);
			root.put(STRUCTURE.SCHEMA_DEFN, xml);
		}
		
		setOverrideResultForChange(root);
	}
}
